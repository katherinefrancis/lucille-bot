const { Command } = require("discord.js-commando")
const { getOrCreateMusic } = require("../../classes/Helpers")

module.exports = class extends Command {
  constructor (client) {
    super(client, {
      name: "bassboost",
      aliases: ["bb", "bass"],
      group: "music",
      memberName: "bassboost",
      description: "Changes the bass boost",
      args: [
        {
          key: "amount",
          prompt: "Amount of bass boost",
          type: "string",
          oneOf: ["off", "low", "med", "high", "insane", "wtfbbq"],
        },
      ],
      guildOnly: true,
    })
  }

  async run (msg, args) {
    const music = getOrCreateMusic(msg)
    music.state.playTime += music.dispatcherExec(d => d.streamTime) || 0
    music.state.bassBoost = bassBoostToAmountMap[args.amount.toLowerCase()]
    music.play("after")
    msg.react("🎸")
  }
}

const bassBoostToAmountMap = {
  off: 0,
  low: 5,
  med: 10,
  high: 15,
  insane: 20,
  wtfbbq: 50,
}