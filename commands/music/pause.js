const { Command } = require("discord.js-commando")
const { getOrCreateMusic } = require("../../classes/Helpers")

module.exports = class extends Command {
  constructor (client) {
    super(client, {
      name: "pause",
      aliases: [],
      group: "music",
      memberName: "pause",
      description: "Pauses the current playing song",
      guildOnly: true,
    })
  }

  async run (msg) {
    const music = getOrCreateMusic(msg)
    music.state.pauser = msg.author.id
    music.dispatcherExec(d => d.pause())
    music.updateEmbed()
    msg.react("⏸️")
  }
}