const { Util } = require("discord.js")

const noop = () => { }

const safeJoin = (array, seperator) => {
  return array.filter(s => s.trim()).join(seperator)
}

const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

const sleep = ms => {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const msToTimestamp = (duration, { ms = false } = {}) => {
  const milliseconds = duration % 1000
  const seconds = Math.floor((duration / 1000) % 60)
  const minutes = Math.floor((duration / (1000 * 60)) % 60)
  const hours = Math.floor((duration / (1000 * 60 * 60)) % 24)

  let out = ""

  if (hours > 0) {
    out += `${hours}:`
  }

  out += `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`

  if (ms && milliseconds > 0) {
    out += `.${milliseconds}`
  }

  return out
}

const selectRandom = array => {
  return array[Math.floor(Math.random() * array.length)]
}

const escapeMarkdown = text => {
  return Util.escapeMarkdown(text || "")
}

module.exports.noop = noop
module.exports.safeJoin = safeJoin
module.exports.shuffle = shuffle
module.exports.sleep = sleep
module.exports.msToTimestamp = msToTimestamp
module.exports.selectRandom = selectRandom
module.exports.escapeMarkdown = escapeMarkdown