const { Command } = require("discord.js-commando")
const { run } = require("../music/play")

module.exports = class WapCommand extends Command {
  constructor (client) {
    super(client, {
      name: "crap",
      memberName: "crap",
      description: "Plays the crap version of WAP",
      group: "fun",
      aliases: [],
    })
  }

  async run (msg, args) {
    run(msg, {
        input: 'wap zane'
    }, 1)
  }
}