# TaskBot

Bot de Telegram que corre **en esta PC** y cuyo cerebro es **Claude Code**
(tu suscripción MAX — no usa API key de Anthropic ni consume créditos aparte).

Le escribís por texto o le mandás un audio, y el agente interpreta la orden y la
ejecuta: crea y consulta tareas de TaskApp, navega el filesystem de la máquina y
te devuelve archivos por Telegram o por mail.

```
Telegram ──► taskbot.mjs ──► claude -p ──► Bash / Read / taskapp CLI
   ▲              │                             │
   └──────────────┴── tg-send.mjs ◄─────────────┘
                      mail-send.mjs
```

## Qué puede hacer

- **Tareas**: "¿qué tengo pendiente?", "creá una tarea en TaskApp para arreglar
  el login", "pasá la 478 a done".
- **Filesystem**: "buscá el último PDF de Descargas", "¿cuánto pesa la carpeta X?".
- **Archivos**: "mandame el informe.pdf" → te llega por Telegram (hasta 50 MB).
  Si pedís mail, o el archivo es muy grande, va por mail con adjunto.
- **Audios**: las notas de voz se transcriben y se tratan igual que un texto.
- Mandale vos un archivo y lo guarda en `.state/inbox/` para trabajar sobre él.

Comandos: `/ayuda`, `/nuevo` (borra el contexto y arranca limpio), `/estado`,
`/vincular <código>` (sólo la primera vez).

## Instalación (en cualquier PC, con tu propio bot)

Requisitos: Linux con systemd, `node` ≥ 20, `ffmpeg` (sólo para audios) y
[Claude Code](https://claude.com/claude-code) logueado con tu cuenta (`claude`
en el PATH).

1. Creá un bot nuevo hablándole a [@BotFather](https://t.me/BotFather)
   (`/newbot`) y copiá el token.
2. Cloná el repo y configurá:

```bash
git clone https://github.com/nachobar3/TaskApp.git && cd TaskApp/bot
cp .env.example .env     # pegá TELEGRAM_BOT_TOKEN e inventá un PAIRING_CODE
./install.sh             # instala y arranca el servicio systemd de usuario
```

3. Escribile a tu bot `/vincular <PAIRING_CODE>`. Listo.

Cada instalación es independiente: el bot que creás vos sólo habla con la PC
donde corre `install.sh`, con tu sesión de Claude Code y tu lista de chats.
En el repo no hay tokens, ids de chat ni rutas de nadie: todo eso vive en
`bot/.env` y `bot/.state/`, que están en `.gitignore`.

`install.sh` habilita **linger**, así el bot arranca con la PC aunque no abras
sesión gráfica, y se reinicia solo si se cae.

La primera vez el bot no conoce tu chat: escribile `/vincular <PAIRING_CODE>`
(el que pusiste en tu `.env`). Queda guardado en `.state/allowed.json` y la
ventana de vinculación se cierra sola. Cualquier otro chat que le escriba recibe
un "no estás autorizado".

### Operación

```bash
journalctl --user -u taskbot -f       # logs en vivo
systemctl --user restart taskbot      # tras tocar .env o el código
systemctl --user stop taskbot         # apagarlo
```

## Configuración (`bot/.env`)

| Variable | Para qué |
|---|---|
| `TELEGRAM_BOT_TOKEN` | token de @BotFather (obligatorio) |
| `TELEGRAM_ALLOWED_CHAT_IDS` | chats autorizados, coma-separados (alternativa al pairing) |
| `PAIRING_CODE` | código de `/vincular` para autorizarte la primera vez |
| `OPENAI_API_KEY` | transcripción de audios (Whisper) |
| `WHISPER_LOCAL_CMD` | alternativa offline: comando local que transcribe |
| `RESEND_API_KEY`, `MAIL_FROM`, `MAIL_DEFAULT_TO` | canal de email |
| `CLAUDE_MODEL`, `CLAUDE_CWD`, `CLAUDE_TIMEOUT_MS` | motor del agente |

Todo lo que falte degrada con aviso: sin `OPENAI_API_KEY` el bot avisa que no
puede oír audios pero sigue respondiendo texto; sin Resend, el canal mail queda
deshabilitado y los archivos igual salen por Telegram.

## Cómo funciona por dentro

- `taskbot.mjs` — long polling contra la Bot API (no necesita puerto expuesto ni
  webhook). Una cola por chat: los pedidos de un mismo chat se procesan en orden.
- `lib/claude.mjs` — lanza `claude -p --output-format stream-json` y mantiene
  **una sesión de Claude por chat** (12 h de inactividad y arranca de cero), así
  la conversación tiene memoria. Los `tool_use` que emite se reenvían como avisos
  de progreso `⚙️` cada 45 s en pedidos largos.
- `lib/transcribe.mjs` — normaliza el audio con ffmpeg (mono 16 kHz mp3) y lo
  transcribe.
- `agent/SYSTEM.md` — el prompt que define el comportamiento del agente: tono de
  chat, herramientas propias y límites. **Editá ahí** para cambiar cómo responde.
- `tools/tg-send.mjs` / `tools/mail-send.mjs` — las dos "manos" del agente para
  devolverte cosas. Las llama con Bash.

## Seguridad

El agente corre con `--permission-mode bypassPermissions`: tiene acceso real a
tu shell y a tus archivos. La única barrera es la allowlist de chats, así que:

- No compartas el token ni el `PAIRING_CODE`.
- Vinculate apenas lo instalás, para cerrar la ventana de pairing.
- Si el token se filtra, revocalo en @BotFather y borrá `.state/allowed.json`.

`agent/SYSTEM.md` además le prohíbe pushear, commitear, borrar archivos ajenos y
mandar contenido de `.env` por chat o mail.
