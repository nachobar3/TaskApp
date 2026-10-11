// Cliente mínimo de la Bot API de Telegram sobre fetch nativo (sin deps).
import fs from 'node:fs'
import path from 'node:path'

const API = 'https://api.telegram.org'

export class Telegram {
  constructor(token) {
    if (!token) throw new Error('Telegram: token vacío')
    this.token = token
  }

  get base() {
    return `${API}/bot${this.token}`
  }

  async call(method, payload = {}, { timeoutMs = 70_000 } = {}) {
    const res = await fetch(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const data = await res.json().catch(() => ({}))
    if (!data.ok) {
      throw new Error(`Telegram ${method} falló: ${data.description || res.status}`)
    }
    return data.result
  }

  async callForm(method, form, { timeoutMs = 300_000 } = {}) {
    const res = await fetch(`${this.base}/${method}`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const data = await res.json().catch(() => ({}))
    if (!data.ok) {
      throw new Error(`Telegram ${method} falló: ${data.description || res.status}`)
    }
    return data.result
  }

  getUpdates(offset, timeout) {
    return this.call(
      'getUpdates',
      { offset, timeout, allowed_updates: ['message', 'edited_message'] },
      { timeoutMs: (timeout + 20) * 1000 },
    )
  }

  // Telegram corta los mensajes en 4096 chars: partimos en trozos.
  async sendMessage(chatId, text, opts = {}) {
    const chunks = splitText(String(text ?? '').trim() || '(vacío)', 3900)
    let last
    for (const chunk of chunks) {
      last = await this.call('sendMessage', {
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
        ...opts,
      })
    }
    return last
  }

  sendChatAction(chatId, action = 'typing') {
    return this.call('sendChatAction', { chat_id: chatId, action }).catch(() => null)
  }

  async sendDocument(chatId, filePath, caption) {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) throw new Error(`No es un archivo: ${filePath}`)
    const form = new FormData()
    form.set('chat_id', String(chatId))
    if (caption) form.set('caption', caption.slice(0, 1024))
    const blob = new Blob([fs.readFileSync(filePath)])
    form.set('document', blob, path.basename(filePath))
    return this.callForm('sendDocument', form)
  }

  async getFileLink(fileId) {
    const file = await this.call('getFile', { file_id: fileId })
    return `${API}/file/bot${this.token}/${file.file_path}`
  }

  async downloadFile(fileId, destPath) {
    const url = await this.getFileLink(fileId)
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
    if (!res.ok) throw new Error(`Descarga de archivo falló: ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    fs.writeFileSync(destPath, buf)
    return destPath
  }
}

// Corta respetando saltos de línea cuando se puede, para no romper bloques.
export function splitText(text, max) {
  if (text.length <= max) return [text]
  const out = []
  let rest = text
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max)
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max)
    if (cut < max * 0.5) cut = max
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, '')
  }
  if (rest) out.push(rest)
  return out
}
