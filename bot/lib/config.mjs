// Carga de configuración del bot. Lee bot/.env (formato KEY=VALUE, sin quotes
// obligatorias) y lo mezcla con process.env. process.env tiene prioridad.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const BOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
export const REPO_DIR = path.dirname(BOT_DIR)

function parseEnvFile(file) {
  const out = {}
  if (!fs.existsSync(file)) return out
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    out[key] = val
  }
  return out
}

const fileEnv = parseEnvFile(path.join(BOT_DIR, '.env'))
for (const [k, v] of Object.entries(fileEnv)) {
  if (process.env[k] === undefined) process.env[k] = v
}

const num = (v, def) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? def : Number(v))

export const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  // Lista blanca de chats autorizados. Vacía = el bot no ejecuta nada y sólo
  // te dice tu chat id para que lo agregues.
  allowedChatIds: (process.env.TELEGRAM_ALLOWED_CHAT_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // Transcripción de audio
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  transcribeModel: process.env.TRANSCRIBE_MODEL || 'whisper-1',
  transcribeLanguage: process.env.TRANSCRIBE_LANGUAGE || 'es',
  // Email saliente (Resend)
  resendApiKey: process.env.RESEND_API_KEY || '',
  mailFrom: process.env.MAIL_FROM || '',
  mailTo: process.env.MAIL_DEFAULT_TO || '',
  // Claude Code
  claudeBin: process.env.CLAUDE_BIN || 'claude',
  claudeModel: process.env.CLAUDE_MODEL || '',
  claudeCwd: process.env.CLAUDE_CWD || REPO_DIR,
  claudeTimeoutMs: num(process.env.CLAUDE_TIMEOUT_MS, 20 * 60 * 1000),
  // Código de vinculación: se manda al bot como `/vincular <código>` la
  // primera vez, para autorizar tu chat sin editar este archivo a mano.
  pairingCode: process.env.PAIRING_CODE || '',
  // Runtime
  stateDir: process.env.BOT_STATE_DIR || path.join(BOT_DIR, '.state'),
  pollTimeout: num(process.env.TELEGRAM_POLL_TIMEOUT, 50),
  maxAudioMb: num(process.env.MAX_AUDIO_MB, 25),
}

export function assertConfig() {
  if (!config.telegramToken) {
    throw new Error('Falta TELEGRAM_BOT_TOKEN (poné bot/.env a partir de bot/.env.example)')
  }
}
