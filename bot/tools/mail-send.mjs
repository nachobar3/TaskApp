#!/usr/bin/env node
// Herramienta que el agente usa para mandarte mails (con adjuntos) vía Resend.
//
//   node bot/tools/mail-send.mjs --subject "Informe" --body "ahí va" --attach /ruta/a.pdf
//
// --to es opcional: por defecto MAIL_DEFAULT_TO de bot/.env.
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../lib/config.mjs'

function parseArgs(argv) {
  const out = { attachments: [], to: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--to') out.to.push(argv[++i])
    else if (a === '--subject') out.subject = argv[++i]
    else if (a === '--body') out.body = argv[++i]
    else if (a === '--body-file') out.bodyFile = argv[++i]
    else if (a === '--html') out.html = true
    else if (a === '--attach') out.attachments.push(argv[++i])
    else if (a === '--from') out.from = argv[++i]
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

if (args.help || !args.subject) {
  console.log('uso: mail-send.mjs --subject "..." [--body "..." | --body-file <p>] [--to <mail>] [--attach <path> ...] [--html]')
  process.exit(args.help ? 0 : 1)
}

if (!config.resendApiKey) {
  console.error('Falta RESEND_API_KEY en bot/.env: el canal de email no está configurado.')
  process.exit(1)
}
if (!config.mailFrom) {
  console.error('Falta MAIL_FROM en bot/.env (remitente verificado en Resend).')
  process.exit(1)
}

const to = args.to.length ? args.to : config.mailTo ? [config.mailTo] : []
if (!to.length) {
  console.error('No sé a quién mandar: pasá --to o definí MAIL_DEFAULT_TO en bot/.env.')
  process.exit(1)
}

let body = args.body || ''
if (args.bodyFile) body = fs.readFileSync(args.bodyFile, 'utf8')

const attachments = []
let totalMb = 0
for (const file of args.attachments) {
  if (!fs.existsSync(file)) {
    console.error(`no existe: ${file}`)
    process.exit(1)
  }
  const buf = fs.readFileSync(file)
  totalMb += buf.length / 1024 / 1024
  attachments.push({ filename: path.basename(file), content: buf.toString('base64') })
}
if (totalMb > 35) {
  console.error(`Adjuntos: ${totalMb.toFixed(1)} MB. Resend acepta hasta ~40 MB por mail; mandá menos archivos.`)
  process.exit(1)
}

const payload = {
  from: args.from || config.mailFrom,
  to,
  subject: args.subject,
  ...(args.html ? { html: body || '<p>(sin cuerpo)</p>' } : { text: body || '(sin cuerpo)' }),
  ...(attachments.length ? { attachments } : {}),
}

const res = await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: {
    authorization: `Bearer ${config.resendApiKey}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(120_000),
})

const data = await res.json().catch(() => ({}))
if (!res.ok) {
  console.error(`Resend falló (${res.status}): ${JSON.stringify(data).slice(0, 400)}`)
  process.exit(1)
}
console.log(`mail enviado a ${to.join(', ')} (id ${data.id || '?'}${attachments.length ? `, ${attachments.length} adjunto(s)` : ''})`)
