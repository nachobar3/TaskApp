// Quién puede usar el bot. Dos fuentes:
//  1) TELEGRAM_ALLOWED_CHAT_IDS en bot/.env (fija, la manda el humano)
//  2) .state/allowed.json, que se llena con el pairing (/vincular <código>)
// El pairing sólo está abierto mientras no haya NINGÚN chat autorizado, y exige
// el PAIRING_CODE de bot/.env: así el bot no queda al alcance de cualquiera que
// adivine su usuario.
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.mjs'

const FILE = () => path.join(config.stateDir, 'allowed.json')

function readPaired() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE(), 'utf8'))
    return Array.isArray(data) ? data.map(String) : []
  } catch {
    return []
  }
}

export function allowedChatIds() {
  return [...new Set([...config.allowedChatIds, ...readPaired()])]
}

export function isAllowed(chatId) {
  return allowedChatIds().includes(String(chatId))
}

export function pairingOpen() {
  return allowedChatIds().length === 0
}

export function pair(chatId) {
  const list = [...new Set([...readPaired(), String(chatId)])]
  fs.mkdirSync(config.stateDir, { recursive: true })
  fs.writeFileSync(FILE(), JSON.stringify(list, null, 2))
  return list
}
