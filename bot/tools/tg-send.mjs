#!/usr/bin/env node
// Herramienta que el agente (Claude Code) usa para mandarte cosas por Telegram.
//
//   node bot/tools/tg-send.mjs --text "hola"
//   node bot/tools/tg-send.mjs --file /ruta/archivo.pdf --caption "el informe"
//
// --chat es opcional: por defecto usa $TELEGRAM_CHAT_ID (el chat que originó
// el pedido, que el bot inyecta en el entorno).
import fs from 'node:fs'
import { config, assertConfig } from '../lib/config.mjs'
import { Telegram } from '../lib/telegram.mjs'

function parseArgs(argv) {
  const out = { files: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--text') out.text = argv[++i]
    else if (a === '--file') out.files.push(argv[++i])
    else if (a === '--caption') out.caption = argv[++i]
    else if (a === '--chat') out.chat = argv[++i]
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

if (args.help || (!args.text && args.files.length === 0)) {
  console.log('uso: tg-send.mjs [--text "msg"] [--file <path> ...] [--caption "..."] [--chat <id>]')
  process.exit(args.help ? 0 : 1)
}

assertConfig()
const chatId = args.chat || process.env.TELEGRAM_CHAT_ID || config.allowedChatIds[0]
if (!chatId) {
  console.error('No sé a qué chat mandar: falta --chat o $TELEGRAM_CHAT_ID')
  process.exit(1)
}

const tg = new Telegram(config.telegramToken)

try {
  if (args.text) {
    await tg.sendMessage(chatId, args.text)
    console.log('mensaje enviado')
  }
  for (const file of args.files) {
    if (!fs.existsSync(file)) {
      console.error(`no existe: ${file}`)
      process.exitCode = 1
      continue
    }
    const mb = fs.statSync(file).size / 1024 / 1024
    if (mb > 50) {
      console.error(`${file} pesa ${mb.toFixed(1)} MB: Telegram no acepta más de 50 MB por bot. Mandalo por mail.`)
      process.exitCode = 1
      continue
    }
    await tg.sendDocument(chatId, file, args.caption)
    console.log(`archivo enviado: ${file} (${mb.toFixed(1)} MB)`)
  }
} catch (err) {
  console.error(`error: ${err.message}`)
  process.exit(1)
}
