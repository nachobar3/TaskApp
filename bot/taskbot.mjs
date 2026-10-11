#!/usr/bin/env node
// TaskBot — bot de Telegram cuyo cerebro es Claude Code (suscripción MAX).
//
// Recibe texto o notas de voz, las interpreta y ejecuta: crea/consulta tareas de
// TaskApp, navega el filesystem de esta PC y te devuelve archivos por Telegram o
// por mail. Corre localmente con long polling (no necesita puerto expuesto).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { config, assertConfig } from './lib/config.mjs'
import { Telegram } from './lib/telegram.mjs'
import { transcribe, transcriptionAvailable } from './lib/transcribe.mjs'
import { runClaude, clearSession, getSession } from './lib/claude.mjs'
import { isAllowed, pairingOpen, pair, allowedChatIds } from './lib/allowlist.mjs'

assertConfig()

const tg = new Telegram(config.telegramToken)
const OFFSET_FILE = path.join(config.stateDir, 'offset')
fs.mkdirSync(config.stateDir, { recursive: true })

const log = (...a) => console.log(new Date().toISOString(), ...a)

function readOffset() {
  try {
    return Number(fs.readFileSync(OFFSET_FILE, 'utf8').trim()) || 0
  } catch {
    return 0
  }
}
const writeOffset = (v) => fs.writeFileSync(OFFSET_FILE, String(v))

// Una cola por chat: los mensajes de un mismo chat se procesan en orden y de a
// uno, así dos pedidos no pelean por la misma sesión de Claude.
const queues = new Map()
function enqueue(chatId, job) {
  const prev = queues.get(chatId) || Promise.resolve()
  const next = prev.then(job).catch((err) => log('job error:', err))
  queues.set(chatId, next)
  return next
}

async function getMessageText(msg) {
  if (msg.text) return { text: msg.text.trim(), viaVoice: false }
  if (msg.caption && (msg.document || msg.photo)) return { text: msg.caption.trim(), viaVoice: false }

  const audio = msg.voice || msg.audio || (msg.video_note ? msg.video_note : null)
  if (!audio) return { text: '', viaVoice: false }

  if (!transcriptionAvailable()) {
    throw new Error(
      'Me llegó un audio pero no tengo transcripción configurada (falta OPENAI_API_KEY o WHISPER_LOCAL_CMD en bot/.env).',
    )
  }
  const sizeMb = (audio.file_size || 0) / 1024 / 1024
  if (sizeMb > config.maxAudioMb) {
    throw new Error(`El audio pesa ${sizeMb.toFixed(1)} MB (máximo ${config.maxAudioMb} MB).`)
  }

  await tg.sendChatAction(msg.chat.id, 'typing')
  const tmp = path.join(os.tmpdir(), `tgvoice-${msg.message_id}-${Date.now()}.ogg`)
  try {
    await tg.downloadFile(audio.file_id, tmp)
    const text = await transcribe(tmp)
    if (!text) throw new Error('No pude entender el audio (transcripción vacía).')
    return { text, viaVoice: true }
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

// Si me mandan un archivo, lo bajo a un directorio de entrada y se lo cuento al
// agente para que pueda trabajar sobre él.
async function saveIncomingFile(msg) {
  const doc = msg.document || (msg.photo ? msg.photo[msg.photo.length - 1] : null)
  if (!doc) return null
  const dir = path.join(config.stateDir, 'inbox')
  fs.mkdirSync(dir, { recursive: true })
  const name = doc.file_name || `telegram-${msg.message_id}.jpg`
  const dest = path.join(dir, `${Date.now()}-${name.replace(/[/\\]/g, '_')}`)
  await tg.downloadFile(doc.file_id, dest)
  return dest
}

function buildPrompt({ text, viaVoice, filePath, msg }) {
  const when = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })
  const parts = [
    `[Mensaje de Telegram — ${when} — chat ${msg.chat.id}]`,
    viaVoice ? '(llegó como nota de voz; esto es la transcripción, puede tener errores menores)' : '',
    filePath ? `(adjuntó un archivo, ya está guardado en: ${filePath})` : '',
    '',
    text || '(sin texto)',
  ]
  return parts.filter(Boolean).join('\n')
}

async function handleCommand(msg, text) {
  const chatId = msg.chat.id
  const cmd = text.split(/\s+/)[0].toLowerCase().replace(/@.*$/, '')
  switch (cmd) {
    case '/start':
    case '/ayuda':
    case '/help':
      await tg.sendMessage(
        chatId,
        [
          'Soy TaskBot 🤖',
          '',
          'Mandame texto o un audio y lo interpreto con Claude Code en tu PC.',
          'Puedo: crear y consultar tareas de TaskApp, buscar en el filesystem, y mandarte archivos por Telegram o mail.',
          '',
          'Ejemplos:',
          '- "¿qué tareas tengo pendientes?"',
          '- "creá una tarea en TaskApp para arreglar el login"',
          '- "mandame el último pdf de la carpeta Descargas"',
          '',
          'Comandos: /nuevo (arranca conversación limpia), /estado, /ayuda',
        ].join('\n'),
      )
      return true
    case '/nuevo':
    case '/reset':
      clearSession(chatId)
      await tg.sendMessage(chatId, 'Listo, arranco de cero 🧹')
      return true
    case '/estado':
    case '/id':
      await tg.sendMessage(
        chatId,
        [
          `chat id: ${chatId}`,
          `sesión Claude: ${getSession(chatId) ? 'activa' : 'nueva'}`,
          `transcripción: ${transcriptionAvailable() ? 'ok' : 'no configurada'}`,
          `mail: ${config.resendApiKey && config.mailFrom ? 'ok' : 'no configurado'}`,
          `cwd: ${config.claudeCwd}`,
          `chats autorizados: ${allowedChatIds().length}`,
        ].join('\n'),
      )
      return true
    default:
      return false
  }
}

// Primer arranque: el dueño se autoriza mandando `/vincular <PAIRING_CODE>`.
// La ventana se cierra sola en cuanto hay un chat autorizado.
async function handleUnauthorized(msg) {
  const chatId = msg.chat.id
  const text = (msg.text || '').trim()
  const [cmd, code] = text.split(/\s+/)

  if (cmd?.toLowerCase().replace(/@.*$/, '') === '/vincular' && pairingOpen()) {
    if (!config.pairingCode) {
      await tg.sendMessage(chatId, 'No hay PAIRING_CODE configurado en bot/.env: no puedo vincular.').catch(() => {})
      return
    }
    if (code !== config.pairingCode) {
      log('pairing rechazado desde', chatId, msg.from?.username)
      await tg.sendMessage(chatId, 'Código incorrecto.').catch(() => {})
      return
    }
    pair(chatId)
    log('chat vinculado:', chatId, msg.from?.username)
    await tg.sendMessage(chatId, 'Listo, quedaste vinculado ✅\nEscribime /ayuda para ver qué puedo hacer.').catch(() => {})
    return
  }

  log('chat no autorizado:', chatId, msg.from?.username)
  const hint = pairingOpen()
    ? 'Si sos el dueño, mandame: /vincular <código>'
    : `Si sos el dueño, agregá ${chatId} a TELEGRAM_ALLOWED_CHAT_IDS en bot/.env y reiniciá el servicio.`
  await tg.sendMessage(chatId, `No estás autorizado.\n\nTu chat id es ${chatId}.\n${hint}`).catch(() => {})
}

async function handleMessage(msg) {
  const chatId = msg.chat.id

  if (!isAllowed(chatId)) {
    await handleUnauthorized(msg)
    return
  }

  let text
  let viaVoice = false
  try {
    const got = await getMessageText(msg)
    text = got.text
    viaVoice = got.viaVoice
  } catch (err) {
    await tg.sendMessage(chatId, `⚠️ ${err.message}`)
    return
  }

  let filePath = null
  try {
    filePath = await saveIncomingFile(msg)
  } catch (err) {
    log('no pude bajar el adjunto:', err.message)
  }

  if (!text && !filePath) return

  if (text.startsWith('/') && (await handleCommand(msg, text))) return

  if (viaVoice) await tg.sendMessage(chatId, `🎙️ "${text}"`)

  // Mantener el "escribiendo…" vivo mientras Claude trabaja (dura ~5 s por envío).
  const keepTyping = setInterval(() => tg.sendChatAction(chatId, 'typing'), 4500)
  await tg.sendChatAction(chatId, 'typing')

  let lastNotice = 0
  const onEvent = (evt) => {
    if (evt.type !== 'tool') return
    // Aviso de actividad espaciado, para no inundar el chat en tareas largas.
    const now = Date.now()
    if (now - lastNotice < 45_000) return
    lastNotice = now
    const detail = evt.detail ? `: ${evt.detail}` : ''
    tg.sendMessage(chatId, `⚙️ ${evt.name}${detail}`).catch(() => {})
  }

  try {
    const started = Date.now()
    const { text: answer, isError } = await runClaude({
      prompt: buildPrompt({ text, viaVoice, filePath, msg }),
      chatId,
      onEvent,
    })
    log(`chat ${chatId}: ${((Date.now() - started) / 1000).toFixed(1)}s${isError ? ' (error)' : ''}`)
    await tg.sendMessage(chatId, isError ? `⚠️ ${answer}` : answer)
  } catch (err) {
    log('error procesando:', err)
    await tg.sendMessage(chatId, `⚠️ Se me rompió algo: ${err.message}`).catch(() => {})
  } finally {
    clearInterval(keepTyping)
  }
}

async function main() {
  const me = await tg.call('getMe')
  log(`TaskBot arriba como @${me.username}`)
  if (pairingOpen()) {
    log(
      config.pairingCode
        ? '⚠️ Sin chats autorizados: mandale "/vincular <PAIRING_CODE>" al bot para habilitarte.'
        : '⚠️ Sin chats autorizados y sin PAIRING_CODE: nadie va a poder usar el bot.',
    )
  } else {
    log(`chats autorizados: ${allowedChatIds().length}`)
  }
  if (!transcriptionAvailable()) log('⚠️ sin transcripción de audio (falta OPENAI_API_KEY o WHISPER_LOCAL_CMD)')
  if (!config.resendApiKey || !config.mailFrom) log('⚠️ email no configurado (RESEND_API_KEY / MAIL_FROM)')

  let offset = readOffset()
  let backoff = 1000

  for (;;) {
    try {
      const updates = await tg.getUpdates(offset, config.pollTimeout)
      backoff = 1000
      for (const u of updates) {
        offset = u.update_id + 1
        writeOffset(offset)
        const msg = u.message || u.edited_message
        if (!msg?.chat) continue
        enqueue(msg.chat.id, () => handleMessage(msg))
      }
    } catch (err) {
      // Timeouts de long polling y cortes de red son esperables: reintentamos.
      log('polling:', err.message)
      await new Promise((r) => setTimeout(r, backoff))
      backoff = Math.min(backoff * 2, 60_000)
    }
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`recibí ${sig}, cierro`)
    process.exit(0)
  })
}

main().catch((err) => {
  log('fatal:', err)
  process.exit(1)
})
