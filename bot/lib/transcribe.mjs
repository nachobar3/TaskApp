// Transcripción de notas de voz / audios de Telegram.
// Primario: API de OpenAI (whisper-1 / gpt-4o-transcribe) con OPENAI_API_KEY.
// Alternativa: un comando local configurable (WHISPER_LOCAL_CMD), para no
// depender de la nube. El audio se normaliza con ffmpeg a mp3 mono 16 kHz.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { config } from './config.mjs'

const execFileAsync = promisify(execFile)

async function toMp3(src) {
  const out = path.join(os.tmpdir(), `tgvoice-${Date.now()}.mp3`)
  try {
    await execFileAsync(
      'ffmpeg',
      ['-y', '-i', src, '-ac', '1', '-ar', '16000', '-b:a', '48k', out],
      { timeout: 180_000 },
    )
    return out
  } catch {
    // Sin ffmpeg (o formato raro): mandamos el original, whisper suele bancarlo.
    return src
  }
}

async function transcribeOpenAI(file) {
  const form = new FormData()
  form.set('file', new Blob([fs.readFileSync(file)]), path.basename(file))
  form.set('model', config.transcribeModel)
  if (config.transcribeLanguage) form.set('language', config.transcribeLanguage)
  form.set('response_format', 'text')

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${config.openaiApiKey}` },
    body: form,
    signal: AbortSignal.timeout(300_000),
  })
  if (!res.ok) {
    throw new Error(`Transcripción falló (${res.status}): ${(await res.text()).slice(0, 300)}`)
  }
  return (await res.text()).trim()
}

async function transcribeLocal(file) {
  const cmd = process.env.WHISPER_LOCAL_CMD
  const { stdout } = await execFileAsync('bash', ['-lc', `${cmd} ${JSON.stringify(file)}`], {
    timeout: 600_000,
    maxBuffer: 10 * 1024 * 1024,
  })
  return stdout.trim()
}

export function transcriptionAvailable() {
  return Boolean(config.openaiApiKey || process.env.WHISPER_LOCAL_CMD)
}

export async function transcribe(srcPath) {
  const audio = await toMp3(srcPath)
  try {
    if (config.openaiApiKey) return await transcribeOpenAI(audio)
    if (process.env.WHISPER_LOCAL_CMD) return await transcribeLocal(audio)
    throw new Error(
      'No hay transcripción configurada: definí OPENAI_API_KEY o WHISPER_LOCAL_CMD en bot/.env',
    )
  } finally {
    if (audio !== srcPath) fs.rmSync(audio, { force: true })
  }
}
