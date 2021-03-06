const scrapeYt = require("scrape-yt")
const ytdl = require("ytdl-core")
const { Util } = require("discord.js")
const index = require("../index")
const config = require("../config.json")
const TopMostMessagePump = require("./TopMostMessagePump")
const { safeJoin, msToTimestamp, selectRandom, escapeMarkdown } = require("../helpers")
const TrackExtractor = require("./TrackExtractor")
const { PLATFORM_YOUTUBE, PLATFORM_RADIO, PLATFORM_SPOTIFY, PLATFORM_TIDAL, PLATFORM_APPLE } = require("./TrackExtractor")
const Track = require("./Track")
const fs = require("fs")
const { RadioMetadata } = require("./RadioMetadata")
const radios = require("../radios.json")
const Axios = require("axios")
const MusicToX = require("./MusicToX")
const debounce = require("lodash.debounce")
const RadioAdBlock = require("./RadioAdBlock")
const { opus: Opus, FFmpeg } = require("prism-media")
const { PassThrough } = require("stream")
const { chooseFormat } = require("ytdl-core")

const PLATFORMS_REQUIRE_YT_SEARCH = [PLATFORM_SPOTIFY, PLATFORM_TIDAL, PLATFORM_APPLE, PLATFORM_YOUTUBE, "search"]

module.exports = class {
  constructor (textChannel) {
    this.state = {
      joinState: 0,
      voiceChannel: null,
      textChannel: textChannel,
      voiceConnection: null,
      queue: [],
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
      progressHandle: null,
      playCount: 0,
      repeat: "off",
      radioAdBlock: new RadioAdBlock(),
      summoned: false,
    }

    // Move the embed down every 5 minutes, it can get lost when a radio is left on for ages
    this.debouncer = debounce(this.updateEmbed, 5 * 60 * 1000)

    this.state.radioAdBlock.on("volume", volume => {
      this.setVolume(volume, true)
    })
  }

  async summon (voiceChannel, userSummoned = false) {
    if (userSummoned) {
      this.state.summoned = true
    }

    // Join the voice channel if not already joining/joined
    if (this.state.joinState === 0) {
      this.state.joinState = 1

      try {
        const connection = await voiceChannel.join()
        connection.play("./assets/sounds/silence.mp3")

        this.state.joinState = 2
        this.state.voiceChannel = voiceChannel
        this.state.voiceConnection = connection
        this.state.playCount = 0

        this.state.voiceConnection.on("disconnect", () => {
          this.state.queue.splice(0, this.state.queue.length)
          this.state.summoned = false
          this.cleanUp()
        })
      }
      catch (err) {
        this.state.joinState = 0
        console.log(err)
      }
    }
    else if (this.state.joinState === 2) {
      if (this.state.voiceConnection && this.state.voiceConnection.voice) {
        await this.state.voiceConnection.voice.setChannel(voiceChannel)
        this.state.voiceChannel = voiceChannel
      }
    }
  }

  async add (input, requestee, voiceChannel, index = -1) {
    const isPlaying = !!this.state.queue.length

    let insertAt = index < 0 ? this.state.queue.length : index
    let tracks = []

    if (typeof input === "string") {
      const trackExtractor = new TrackExtractor(input)

      if (trackExtractor.parseLinks()) {
        const links = await trackExtractor.getAllLinkInfo()

        tracks = links.map(l => l.setRequestee(requestee).setQuery(`official audio lyrics ${l.artists} ${l.title}`))
      }
      else {
        const track = new Track()
          .setRequestee(requestee)
          .setPlatform("search")
          .setQuery(input)

        const searchResults = (await scrapeYt.search(track.query)).filter(res => res.type === "video")
        const searchResult = searchResults[0]

        // console.log(`Search YouTube for ${track.query}\nTrack object: ${JSON.stringify(track)}\nSearch object: ${JSON.stringify(searchResults)}`)

        if (searchResult) {
          track
            .setYouTubeTitle(searchResult.title)
            .setThumbnail(searchResult.thumbnail)
            .setLink(`https://www.youtube.com/watch?v=${searchResult.id}`)
            .setDuration(searchResult.duration)

          tracks = [track]
        }
        else {
          return false
        }
      }
    }
    else if (Array.isArray(input) && input.every(i => i instanceof Track)) {
      tracks.push(...input.map(i => i.setRequestee(requestee)))
    }

    if (!tracks.length) {
      return
    }

    // If we're adding an item to the end of the queue & there's something in the queue already
    if (index < 0 && this.state.queue.length > 1) {
      const isAddingRadio = !!tracks.find(t => t.platform === PLATFORM_RADIO)
      const radioIndex = this.state.queue.findIndex((t, idx) => idx > 0 && t.platform === PLATFORM_RADIO)
      // If there's a radio in the queue
      if (radioIndex >= 0) {
        // And we're adding a radio, delete the old radio
        if (isAddingRadio) {
          this.state.queue.splice(radioIndex, 1)
        }

        // Update the insert index, to put it where the old radio was
        insertAt = radioIndex
      }
    }

    this.state.queue.splice(insertAt, 0, ...tracks)

    if (this.state.queue.length > 0) {
      // Join the voice channel if not already joining/joined
      if (this.state.joinState === 0) {
        await this.summon(voiceChannel)
      }

      // If there's nothing playing, get the ball rolling
      if (!isPlaying) {
        this.searchAndPlay()
      }
      else {
        // If there's a radio currently playing & there's something else in the queue (because we've just added it above)
        if (this.state.queue[0].platform === PLATFORM_RADIO && this.state.queue.length > 1) {
          // Then capture the radio
          const [radio] = this.state.queue
          // And clone it's reference to the end of the queue as long as the second item in the queue isn't a radio
          // This is because we only allow 1 radio in the queue at a time
          if (this.state.queue[1].platform !== PLATFORM_RADIO) {
            this.state.queue.push(radio)
          }

          // End so the finish event is fired, which also removes the first item in the queue essentially skipping.
          // This also fixes the duration issue that occurred when playing the radio for a long time and then playing a song.
          // The duration is reset when the dispatcher finishes.
          this.dispatcherExec(d => d.end())
        }
        else {
          this.updateEmbed()
        }
      }
    }

    return true
  }

  async searchAndPlay () {
    const item = this.state.queue[0]

    if (item.link) {
      this.play()
    }
    else {
      const searchResults = (await scrapeYt.search(item.query)).filter(res => res.type === "video")
      const searchResult = searchResults[0]

      if (searchResult) {
        item.setLink(`https://www.youtube.com/watch?v=${searchResult.id}`)
          .setYouTubeTitle(searchResult.title)
          .setDuration(searchResult.duration)
        this.play()
      }
      else {
        console.log(`Couldn't find a video for: ${item.query}`)
      }
    }
  }

  getYTStream (url) {
    return new Promise((resolve, reject) => {
      ytdl.getInfo(url)
        .then(info => {
          const format = chooseFormat(info.formats, { quality: "highestaudio" })
          const FFmpegArgs = [
            "-ss", msToTimestamp(this.state.playTime, { ms: true }),
            "-i", format.url,
            ...this.getFFMpegArgs(),
            "-analyzeduration", "0",
            "-loglevel", "0",
            "-f", "s16le",
            "-ar", "48000",
            "-ac", "2",
          ]

          const passThroughStream = new PassThrough({ highWaterMark: 1 << 25 })
          const transcoder = new FFmpeg({ args: FFmpegArgs })
          const opus = new Opus.Encoder({
            rate: 48000,
            channels: 2,
            frameSize: 960,
          })

          const output = transcoder.pipe(passThroughStream)
          const outputStream = output.pipe(opus)

          transcoder.once("readable", () => {
            resolve(outputStream)
          })

          outputStream.on("close", () => {
            transcoder.destroy()
            opus.destroy()
          })

          outputStream.on("end", () => console.log("ffmpeg end"))
          outputStream.on("error", err => console.log(`ffmpeg error:\n${err.message}`))
        })
        .catch(err => {
          console.log(`ytdl getInfo error:\n${err.message}`)
          reject(err)
        })
    })
  }

  async play (update = "before") {
    const item = this.state.queue[0]
    const fetchYTStream = PLATFORMS_REQUIRE_YT_SEARCH.includes(item.platform)
    let stream

    if (item.startTime) {
      this.state.playTime = item.startTime * 1000
    }

    if (update === "before") {
      this.updateEmbed()
    }

    if (fetchYTStream) {
      try {
        stream = await this.getYTStream(item.link)
      }
      catch (err) {
        this.state.textChannel.send(`Failed to get a YouTube stream for\n${this.getTrackTitle(item)}\n${item.link}`)
        this.processQueue()
        return
      }
    }
    else {
      stream = await this.getMediaStream(item)
    }

    if (this.state.playCount === 0) {
      try {
        await this.connectSound()
      }
      catch (err) {
        console.log("Failed to play connect sound")
        console.log(err)
      }
    }

    this.state.playCount++

    const dispatcher = this.state.voiceConnection.play(stream, fetchYTStream ? { type: "opus" } : undefined)
    dispatcher.setVolumeLogarithmic(this.state.volume / 100)

    if (update === "after") {
      this.updateEmbed()
    }

    dispatcher.on("start", () => {
      console.log("Stream starting...")
      this.cleanProgress()
      if (item.duration > 0) {
        this.state.progressHandle = setInterval(() => this.updateEmbed(true), 5000)
      }
      this.startRadioMetadata(item)
    })

    dispatcher.on("finish", () => {
      console.log("Stream finished...")

      item.setFinished()
      this.updateEmbed(true)
      this.cleanProgress()
      this.stopRadioMetadata(item)
      this.processQueue()
    })

    dispatcher.on("error", err => {
      console.log(err)
    })
  }

  async getMediaStream (item) {
    if (item.platform === PLATFORM_RADIO) {
      const radio = Object.values(radios).find(r => r.url === item.link)

      if (radio) {
        item.setRadio(radio)

        if (radio.metadata && radio.metadata.type === "sse") {
          try {
            const res = await Axios({
              method: "GET",
              url: item.link,
              responseType: "stream",
            })

            item.setRequestStream(res)

            return res.data
          }
          catch (err) {
            console.log("Error occured when getting radio stream")
            console.log(err)
          }
        }
      }
    }

    return item.link
  }

  getFFMpegArgs () {
    return [
      "-af",
      `equalizer=f=40:width_type=h:width=50:g=${this.state.bassBoost},atempo=${this.state.tempo}`,
    ]
  }

  processQueue () {
    if (this.state.repeat === "all") {
      if (this.state.queue.length > 0) {
        this.state.queue.push(this.state.queue.shift())
      }
    }
    else if (this.state.repeat === "off") {
      this.state.queue.shift()
    }

    this.state.playTime = 0

    if (this.state.queue.length < 1) {
      this.disconnectSound()
    }
    else {
      this.searchAndPlay()
    }
  }

  setRepeat (type) {
    this.state.repeat = type
    this.updateEmbed()
  }

  setVolume (volume, isRadioAdBlock = false) {
    this.state.volume = volume
    this.dispatcherExec(d => d.setVolumeLogarithmic(volume / 100))
    this.updateEmbed()

    if (!isRadioAdBlock) {
      this.state.radioAdBlock.setVolume(volume)
    }
  }

  connectSound () {
    return new Promise((resolve, reject) => {
      const path = "assets/sounds/connect"
      const sounds = fs.existsSync(path) && fs.readdirSync(path)
      if (sounds && !sounds.length) {
        resolve()
      }
      else {
        const dispatcher = this.state.voiceConnection.play(`${path}/${selectRandom(sounds)}`)
        dispatcher.setVolumeLogarithmic(3)
        dispatcher.on("finish", () => {
          resolve()
        })
        dispatcher.on("error", err => {
          reject(err)
        })
      }
    })
  }

  disconnectSound () {
    const disconnect = () => {
      if (!this.state.summoned) {
        this.state.voiceConnection.disconnect()
      }
      this.cleanUp()
    }

    const path = "assets/sounds/disconnect"
    const sounds = fs.existsSync(path) && fs.readdirSync(path)
    if (sounds && !sounds.length) {
      disconnect()
    }
    else {
      const dispatcher = this.state.voiceConnection.play(`${path}/${selectRandom(sounds)}`)
      dispatcher.setVolumeLogarithmic(3)
      dispatcher.once("finish", disconnect)
    }
  }

  cleanProgress () {
    if (this.state.progressHandle) {
      clearInterval(this.state.progressHandle)
      this.state.progressHandle = null
    }
  }

  cleanUp () {
    this.debouncer.cancel()
    this.state.voiceConnection = null
    this.state.voiceChannel = null
    this.state.joinState = 0
    this.state.messagePump.clear()
  }

  startRadioMetadata (item) {
    // Any commands that just play the stream again ie. bass boost, don't fire the finish event,
    // so we need to make sure it gets cleaned up.
    this.stopRadioMetadata(item)

    if (item.radio && item.radio.metadata) {
      const radioMetadata = new RadioMetadata(item.radio.metadata.type, item.radio.metadata.url, item.radio.metadata.type === "sse" ? item.requestStream : item.radio.metadata.summon)
      const metadata = {
        instance: radioMetadata,
      }

      item.setRadioMetadata(metadata)

      radioMetadata.subscribe(info => {
        metadata.info = info

        this.radioMusicToX(item)
        this.updateEmbed(true)
      })

      radioMetadata.subscribe(info => {
        this.state.radioAdBlock.toggle(!info.artist && !info.title)
      })
    }
  }

  stopRadioMetadata (item) {
    if (item.radioMetadata && item.radioMetadata.instance) {
      item.radioMetadata.instance.dispose()
      item.setRadioMetadata(undefined)
      this.state.radioAdBlock.toggle(false)
    }
  }

  async radioMusicToX (item) {
    if (item.radioMetadata && item.radioMetadata.info.artist && item.radioMetadata.info.title) {
      const sanitise = str => str
        .replace(/(?<=\b) ft. (?=\b)/gi, " ")
        .replace(/(?<=\b) feat. (?=\b)/gi, " ")
        .replace(/(?<=\b) and (?=\b)/gi, " ")
        .replace(/(?<=\b) & (?=\b)/g, " ")

      const m2x = new MusicToX({
        platform: PLATFORM_RADIO,
        type: "track",
        artists: sanitise(item.radioMetadata.info.artist),
        title: sanitise(item.radioMetadata.info.title),
      })

      try {
        const res = await m2x.processLink()
        if (res && item.radioMetadata) {
          item.radioMetadata.musicToX = res
          this.updateEmbed(true)
        }
      }
      catch (err) {
        console.log("Error when processing radio metadata m2x")
        console.log(err)
      }
    }
    else {
      if (item.radioMetadata) {
        item.radioMetadata.musicToX = undefined
      }
    }
  }

  updateEmbed (edit = false) {
    const currentlyPlaying = this.state.queue[0]
    if (currentlyPlaying) {
      const progressPerc = this.getPlaybackProgress(currentlyPlaying)
      this.state.messagePump.set(this.createQueueEmbed(currentlyPlaying, progressPerc), edit)

      if (!edit) {
        this.debouncer()
      }
    }
  }

  getPlaybackProgress (track) {
    if (track.finished) {
      return 1
    }
    const durationMs = track.duration * 1000
    const elapsed = Math.min(this.state.playTime + (this.dispatcherExec(d => d.streamTime) || 0), durationMs)
    const progressPerc = durationMs === 0 ? 0 : elapsed / durationMs

    return progressPerc
  }

  getTrackTitle (track) {
    return track.platform === "search" ? track.youTubeTitle : safeJoin([track.artists, track.title], " - ")
  }

  createQueueEmbed (currentlyPlaying, progressPerc) {
    const queue = this.state.queue.slice(1).map((t, i) => `\`${(i + 1).toString().padStart(2, "0")}\` ${escapeMarkdown(this.getTrackTitle(t))} <@${t.requestee.id}>`.slice(0, 1024))
    const top10Items = queue.slice(0, 10)
    const top10 = Util.splitMessage(top10Items, { maxLength: 1024 })
    const remainingCount = this.state.queue.length - 1 - top10Items.length

    const platformEmoji = this.getPlatformEmoji(currentlyPlaying.platform)
    const nowPlayingSource = ![PLATFORM_YOUTUBE, "search"].includes(currentlyPlaying.platform) ? `${platformEmoji ? `${platformEmoji} ` : ""}${escapeMarkdown(safeJoin([currentlyPlaying.artists, currentlyPlaying.title], " - "))}` : ""
    const nowPlayingYouTube = PLATFORMS_REQUIRE_YT_SEARCH.includes(currentlyPlaying.platform) ? `${this.state.emojis.youtube} [${escapeMarkdown(currentlyPlaying.youTubeTitle)}](${currentlyPlaying.link})` : ""

    const radioMusicToX = this.getRadioMusicToXInfo(currentlyPlaying)
    const radioNowPlaying = currentlyPlaying.platform === PLATFORM_RADIO && currentlyPlaying.radioMetadata && currentlyPlaying.radioMetadata.info ? escapeMarkdown([currentlyPlaying.radioMetadata.info.artist || "", currentlyPlaying.radioMetadata.info.title || ""].filter(s => s.trim()).join(" - ") + (radioMusicToX ? " " + radioMusicToX : "")) : ""

    const nowPlaying = [nowPlayingSource, nowPlayingYouTube, radioNowPlaying].filter(s => s.trim()).join("\n")
    const blocks = Math.round(20 * progressPerc)

    return {
      embed: {
        color: 0x0099ff,
        title: "Lucille :musical_note:",
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
          ...this.state.queue.length > 1 ? [{
            name: "Up Next",
            value: top10[0],
          }] : [],
          ...remainingCount > 0 ? [{
            name: "Up Next",
            value: `${remainingCount} more song(s)...`,
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
          ...this.state.repeat !== "off" ? [{
            name: "Repeat",
            value: mapRepeatTypeToEmoji(this.state.repeat),
            inline: true,
          }] : [],
          ...currentlyPlaying.platform === PLATFORM_RADIO && !this.state.radioAdBlock.isMethod(RadioAdBlock.METHOD_OFF) ? [{
            name: "Radio AdBlock",
            value: (this.state.radioAdBlock.isMethod(RadioAdBlock.METHOD_LOWER) ? "🔉" : "🔈") + (this.state.radioAdBlock.isBlocking() ? "🟢" : "🔴"),
            inline: true,
          }] : [],
          ...currentlyPlaying.duration > 0 ? [{
            name: "Progress",
            value: "`" + msToTimestamp((currentlyPlaying.duration * 1000) * progressPerc) + "` " + ("▬".repeat(blocks)) + "🔵" + ("▬".repeat(Math.max(0, 20 - blocks))) + " `" + msToTimestamp(currentlyPlaying.duration * 1000) + "`",
          }] : [],
        ],
        footer: {
          text: config.discord.footer,
          icon_url: config.discord.authorAvatarUrl,
        },
      },
    }
  }

  getPlatformEmoji (platform) {
    switch (platform) {
      case PLATFORM_RADIO:
        return ":radio:"
      default:
        return this.state.emojis[platform]
    }
  }

  getRadioMusicToXInfo (item) {
    if (item.platform === PLATFORM_RADIO && item.radioMetadata && item.radioMetadata.musicToX) {
      const musicToX = item.radioMetadata.musicToX
      const splitApple = (musicToX.appleId || "").split("-")
      const radioMusicToX = [
        musicToX.spotifyId && `[${this.state.emojis.spotify}](https://open.spotify.com/track/${musicToX.spotifyId})`,
        musicToX.tidalId && `[${this.state.emojis.tidal}](https://tidal.com/browse/track/${musicToX.tidalId})`,
        musicToX.appleId && `[${this.state.emojis.apple}](https://music.apple.com/gb/track/${splitApple[0]}?i=${splitApple[1]})`,
      ].filter(s => s).join(" ")

      return radioMusicToX
    }

    return ""
  }

  getTextChannel () {
    return this.state.textChannel
  }

  dispatcherExec (callback) {
    if (this.state.voiceConnection && this.state.voiceConnection.dispatcher) {
      return callback(this.state.voiceConnection.dispatcher)
    }
  }
}

const amountToBassBoostMap = {
  0: "Off",
  5: "Low",
  10: "Med",
  15: "High",
  20: "Insane",
  50: "WTFBBQ",
}

const mapRepeatTypeToEmoji = type => {
  switch (type) {
    case "off":
      return "⏭️"
    case "one":
      return "🔂"
    case "all":
      return "🔁"
    default:
      return ""
  }
}

module.exports.mapRepeatTypeToEmoji = mapRepeatTypeToEmoji