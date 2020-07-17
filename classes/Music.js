// const { Command } = require("discord.js-commando")
// const TrackExtractor = require("./TrackExtractor")
// const youtube = require("scrape-youtube").default
const scrapeYt = require("scrape-yt")
const ytdl = require("discord-ytdl-core")
const StringSplitter = require("./StringSplitter")
// const Track = require("./Track")
// const Requestee = require("./Requestee")
const index = require("../index")
const config = require("../config.json")
const TopMostMessagePump = require("./TopMostMessagePump")
const { safeJoin, sleep, msToTimestamp } = require("../helpers")
const { amountToBassBoostMap } = require("../commands/music/bassboost")

module.exports = class {
  constructor (textChannel) {
    this.state = {
      joinState: 0,
      voiceChannel: null,
      textChannel: textChannel,
      voiceConnection: null,
      queue: [],
      currentVideo: {},
      emojis: index.emojis.reduce((acc, cur) => {
        acc[cur.name] = (textChannel.guild.emojis.cache.find(e => e.name === cur.name) || "").toString()
        return acc
      }, {}),
      pauser: "",
      messagePump: new TopMostMessagePump(textChannel),
      playTime: 0,
      bassBoost: 0,
      tempo: 1,
      volume: 100,
      progress: 0,
      progressHandle: null,
    }
  }

  async searchAndPlay () {
    const item = this.state.queue[0]

    // if (item.platform === "search") {
    if (item.link) {
      this.play()
    }
    else {
      // const query = `${item.artists} ${item.title}`.trim()
      const searchResults = (await scrapeYt.search(item.query)).filter(res => res.type === "video")
      const searchResult = searchResults[0]

      if (searchResult) {
        item.setLink(`https://www.youtube.com/watch?v=${searchResult.id}`)
          .setYouTubeTitle(searchResult.title)
          .setDuration(searchResult.duration)
        this.state.currentVideo = searchResult
        this.play()
      }
      else {
        console.log(`Couldn't find a video for: ${item.query}`)
      }
    }
  }

  async getYTStream (url) {
    let stream = null

    for (let i = 0; i < 5; i++) {
      try {
        stream = ytdl(url, {
          // filter: "audioonly",
          // quality: "highestaudio",
          // highWaterMark: 1024 * 1024 * 10,
          highWaterMark: 1 << 25,
          seek: this.state.playTime / 1000,
          encoderArgs: [
            "-af",
            `equalizer=f=40:width_type=h:width=50:g=${this.state.bassBoost},atempo=${this.state.tempo}`,
          ],
        })

        break
      }
      catch (err) {
        console.log(`Failed to get YT stream, attempt ${i + 1} of 5`)
        console.error(err)

        stream = null

        await sleep(3000)
      }
    }

    return stream
  }

  async play () {
    this.updateEmbed()

    const item = this.state.queue[0]
    const stream = await this.getYTStream(item.link)
    if (!stream) {
      this.state.textChannel.send(`Failed to get a YouTube stream for\n${this.getTrackTitle(item)}\n${item.link}`)
      // this.state.queue.shift()
      // this.play()
      this.processQueue()
      return
    }

    // stream.once("data", () => {
    const dispatcher = this.state.voiceConnection.play(stream, { type: "opus" })
    dispatcher.setVolumeLogarithmic(this.state.volume / 100)

    dispatcher.on("start", () => {
      console.log("Stream starting...")
      this.cleanProgress()
      this.state.progressHandle = setInterval(() => this.updateEmbed(true, false), 5000)
    })

    dispatcher.on("finish", () => {
      console.log("Stream finished...")

      // One last update so the progress bar reaches the end
      this.updateEmbed(true, false)
      this.cleanProgress()
      this.processQueue()
    })

    dispatcher.on("error", err => {
      console.log(err)
    })
    // })
  }

  processQueue () {
    this.state.queue.shift()
    this.state.playTime = 0

    if (this.state.queue.length < 1) {
      this.state.voiceConnection.disconnect()
      this.cleanUp()
    }
    else {
      this.searchAndPlay()
    }
  }

  cleanProgress () {
    if (this.state.progressHandle) {
      clearInterval(this.state.progressHandle)
      this.state.progressHandle = null
    }
  }

  cleanUp () {
    this.state.voiceConnection = null
    this.state.voiceChannel = null
    this.state.joinState = 0
    this.state.messagePump.clear()
  }

  updateEmbed (edit = false, force = true) {
    const currentlyPlaying = this.state.queue[0]
    if (currentlyPlaying) {
      const progressPerc = this.getPlaybackProgress(currentlyPlaying.duration)
      if (this.state.progress !== progressPerc || force) {
        this.state.messagePump.set(this.createQueueEmbed(currentlyPlaying, progressPerc), edit)
      }
    }
  }

  getPlaybackProgress (duration) {
    const durationMs = duration * 1000
    const elapsed = Math.min(this.state.playTime + (this.dispatcherExec(d => d.streamTime) || 0), durationMs)
    const progressPerc = elapsed / durationMs
    // const blocks = Math.ceil(20 * progressPerc)

    return progressPerc
  }

  getTrackTitle (track) {
    return track.platform === "search" ? track.youTubeTitle : safeJoin([track.artists, track.title], " - ")
  }

  createQueueEmbed (currentlyPlaying, progressPerc) {
    const queue = this.state.queue/* .slice(1, 1 + QUEUE_TRACKS) */.slice(1).map((t, i) => `${i + 1}. ${this.getTrackTitle(t)} <@${t.requestee.id}>`)
    const splitQueue = new StringSplitter(queue).split()

    const nowPlayingSource = !["youtube", "search"].includes(currentlyPlaying.platform) ? `${this.state.emojis[currentlyPlaying.platform]} ${safeJoin([currentlyPlaying.artists, currentlyPlaying.title], " - ")}` : ""
    const nowPlayingYouTube = `${this.state.emojis.youtube} [${currentlyPlaying.youTubeTitle}](${currentlyPlaying.link})`
    const nowPlaying = [nowPlayingSource, nowPlayingYouTube].filter(s => s.trim()).join("\n")

    const blocks = Math.ceil(20 * progressPerc)

    return {
      embed: {
        color: 0x0099ff,
        title: "Tidify 2.0",
        url: "https://discord.js.org",
        author: {
          name: currentlyPlaying.requestee.displayName,
          icon_url: currentlyPlaying.requestee.avatar,
        },
        fields: [
          {
            name: "Now Playing",
            value: nowPlaying,
            inline: true,
          },
          // { name: "\u200b", value: "\u200b", inline: true },
          // { name: "\u200b", value: "\u200b", inline: true },
          ...splitQueue.strings.map(q => ({
            name: "Up Next",
            value: q.subString,
          })),
          ...splitQueue.remaining.length > 0 ? [{
            name: "Up Next",
            value: `${splitQueue.remaining.length} more song(s)...`,
          }] : [],
          ...this.state.voiceConnection && this.state.voiceConnection.dispatcher && this.state.voiceConnection.dispatcher.paused ? [{
            name: "Paused By",
            value: `<@${this.state.pauser}>`,
            inline: true,
          }] : [],
          ...this.state.bassBoost > 0 ? [{
            name: "Bass Boost",
            value: `${amountToBassBoostMap[this.state.bassBoost]}`,
            inline: true,
          }] : [],
          ...this.state.tempo !== 1 ? [{
            name: "Speed",
            value: `${this.state.tempo}`,
            inline: true,
          }] : [],
          ...this.state.volume !== 100 ? [{
            name: "Volume",
            value: `${this.state.volume}`,
            inline: true,
          }] : [],
          {
            name: "Progress",
            value: msToTimestamp((currentlyPlaying.duration * 1000) * progressPerc) + " " + ("▬".repeat(blocks)) + "🔵" + ("▬".repeat(Math.max(0, 20 - blocks - 1))) + " " + msToTimestamp(currentlyPlaying.duration * 1000),
          },
        ],
        footer: {
          text: "Created with ♥ by Migul",
          icon_url: config.discord.authorAvatarUrl,
        },
      },
    }
  }

  dispatcherExec (callback) {
    if (this.state.voiceConnection && this.state.voiceConnection.dispatcher) {
      return callback(this.state.voiceConnection.dispatcher)
    }
  }
}

// const QUEUE_TRACKS = 10
// const QUEUE_FIELD_MAX_CHARS = 1024