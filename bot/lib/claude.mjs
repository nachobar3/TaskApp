// Motor del bot: Claude Code en modo headless (`claude -p`), usando la sesión
// del usuario (suscripción MAX) — no hay API key de Anthropic de por medio.
// Mantiene una sesión de Claude por chat para que la conversación tenga memoria.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { config, BOT_DIR, REPO_DIR } from './config.mjs'

const SESSIONS_FILE = () => path.join(config.stateDir, 'sessions.json')
const SESSION_TTL_MS = 12 * 60 * 60 * 1000 // 12 h sin hablar → sesión nueva

function readSessions() {
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE(), 'utf8'))
  } catch {
    return {}
  }
}

function writeSessions(data) {
  fs.mkdirSync(config.stateDir, { recursive: true })
  fs.writeFileSync(SESSIONS_FILE(), JSON.stringify(data, null, 2))
}

export function getSession(chatId) {
  const all = readSessions()
  const entry = all[String(chatId)]
  if (!entry) return null
  if (Date.now() - (entry.updatedAt || 0) > SESSION_TTL_MS) return null
  return entry.sessionId || null
}

export function setSession(chatId, sessionId) {
  const all = readSessions()
  all[String(chatId)] = { sessionId, updatedAt: Date.now() }
  writeSessions(all)
}

export function clearSession(chatId) {
  const all = readSessions()
  delete all[String(chatId)]
  writeSessions(all)
}

/**
 * Corre Claude Code y devuelve { text, sessionId, isError }.
 * onEvent recibe avisos de actividad ({type:'tool', name, detail}) para poder
 * mostrarle progreso al usuario mientras el agente trabaja.
 */
// El prompt del agente usa {{BOT_DIR}} / {{REPO_DIR}} para no fijar rutas de
// una PC en particular; se renderiza a .state/ en cada arranque.
function renderSystemPrompt() {
  const out = path.join(config.stateDir, 'SYSTEM.md')
  const src = fs.readFileSync(path.join(BOT_DIR, 'agent', 'SYSTEM.md'), 'utf8')
  fs.mkdirSync(config.stateDir, { recursive: true })
  fs.writeFileSync(out, src.replaceAll('{{BOT_DIR}}', BOT_DIR).replaceAll('{{REPO_DIR}}', REPO_DIR))
  return out
}
const SYSTEM_PROMPT = renderSystemPrompt()

export function runClaude({ prompt, chatId, onEvent = () => {} }) {
  const sessionId = getSession(chatId)
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'bypassPermissions',
    '--append-system-prompt-file', SYSTEM_PROMPT,
  ]
  if (config.claudeModel) args.push('--model', config.claudeModel)
  if (sessionId) args.push('--resume', sessionId)

  return new Promise((resolve) => {
    const child = spawn(config.claudeBin, args, {
      cwd: config.claudeCwd,
      env: {
        ...process.env,
        // El agente necesita saber a qué chat responder al mandar archivos.
        TELEGRAM_CHAT_ID: String(chatId),
        // Evita que un Claude anidado herede la sesión del bot por accidente.
        CLAUDE_CODE_ENTRYPOINT: 'taskbot',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let buf = ''
    let stderr = ''
    let finalText = ''
    let newSessionId = sessionId
    let isError = false
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      isError = true
      finalText = `⏱️ La tarea superó el límite de ${Math.round(config.claudeTimeoutMs / 60000)} min y se cortó.`
      child.kill('SIGKILL')
    }, config.claudeTimeoutMs)

    const handleEvent = (evt) => {
      if (evt.session_id) newSessionId = evt.session_id
      if (evt.type === 'assistant' && evt.message?.content) {
        for (const block of evt.message.content) {
          if (block.type === 'tool_use') {
            onEvent({ type: 'tool', name: block.name, detail: describeTool(block) })
          }
        }
      }
      if (evt.type === 'result') {
        if (typeof evt.result === 'string' && evt.result.trim()) finalText = evt.result
        if (evt.is_error) isError = true
      }
    }

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString()
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        try {
          handleEvent(JSON.parse(line))
        } catch {
          /* línea no-JSON: ignorar */
        }
      }
    })

    child.stderr.on('data', (c) => {
      stderr += c.toString()
      if (stderr.length > 8000) stderr = stderr.slice(-8000)
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ text: `No pude ejecutar Claude Code: ${err.message}`, sessionId, isError: true })
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (newSessionId && newSessionId !== sessionId) setSession(chatId, newSessionId)
      else if (newSessionId) setSession(chatId, newSessionId)
      if (!finalText) {
        isError = true
        finalText = code === 0
          ? 'Claude terminó sin devolver texto.'
          : `Claude terminó con código ${code}.${stderr ? `\n\n${stderr.slice(-1200)}` : ''}`
      }
      resolve({ text: finalText, sessionId: newSessionId, isError })
    })

    child.stdin.write(prompt)
    child.stdin.end()
  })
}

function describeTool(block) {
  const i = block.input || {}
  switch (block.name) {
    case 'Bash':
      return String(i.command || '').slice(0, 120)
    case 'Read':
    case 'Edit':
    case 'Write':
      return String(i.file_path || '').split('/').slice(-2).join('/')
    case 'Grep':
    case 'Glob':
      return String(i.pattern || '').slice(0, 80)
    default:
      return ''
  }
}
