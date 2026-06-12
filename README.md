# TaskApp

App local para coordinar varias sesiones/loops de Claude que corren por
proyecto. Vos administrás tareas desde una UI web; los loops las leen, reportan
progreso y te hacen preguntas que respondés en la misma UI.

```
project ─┬─ document (To-Do, Bugs, …) ─┬─ task (status · stage · tested) ─┬─ question
         │                             │                                  └─ answer
         └─ (un proyecto por sesión de Claude)
```

- **status**: `todo · in_progress · blocked · done` (lo maneja el loop)
- **stage**: `local · develop · production` — dónde quedó el resultado (lo maneja el loop)
- **tested**: lo tildás vos cuando probaste la feature
- **question**: el loop te pregunta algo → badge de notificación en la UI → respondés ahí

## Arquitectura

- **App Next.js** (`app/`) en `localhost:3000`: la UI. Hace polling cada 2s.
- **SQLite** (`~/.taskapp/taskapp.db`, WAL): fuente de verdad, compartida.
- **CLI** (`cli/taskapp.mjs`): lo usan los loops, va directo a SQLite (funciona
  con la app cerrada).
- **Skill** (`skills/taskapp/SKILL.md`): el protocolo que cada proyecto le da a
  su loop.

La app y el CLI comparten el esquema en `lib/schema.mjs`.

## Workers efímeros (lanzar Claude desde la app)

Además del loop interactivo en una terminal, la app puede lanzar **workers**:
procesos `claude -p --dangerously-skip-permissions` que corren en el `path` del
proyecto, drenan la cola de tareas siguiendo la skill y terminan
(`lib/worker.ts`).

- **⚡ auto worker** (toggle por proyecto): la app lanza un worker cuando creás
  una tarea, respondés una pregunta, mandás un follow-up o pedís commit/push.
  No lo prendas si corrés un loop interactivo en una terminal para ese proyecto.
- **▶ Correr ahora**: lanza un worker manualmente (aunque auto esté apagado).
- Nunca hay dos workers por proyecto (guard por PID vivo). Una pregunta
  bloqueante termina el worker; responderla en la UI lanza otro que retoma.
- Logs por proyecto en `~/.taskapp/logs/`. Binario configurable con
  `$TASKAPP_CLAUDE_BIN` (default: `claude` en el PATH del server).

**Follow-ups (hilo por task)**: en una task hecha podés "pedir algo más" desde
la UI; eso la reabre como continuación. El worker lee el hilo completo (body,
resumen, preguntas, follow-ups) y su próximo `taskapp done` responde el
follow-up sin pisar el resumen original.

## Levantar la UI

```bash
npm install
npm run dev      # http://localhost:7777
```

La base se crea sola en `~/.taskapp/taskapp.db` (o donde apunte `$TASKAPP_DB`).

## Acceso remoto / mobile (PWA)

La app es responsive y se instala como PWA. Como TaskApp corre en TU máquina
(los workers lanzan `claude` localmente), el acceso desde el celular o fuera de
casa se resuelve exponiendo el server local de forma privada con
[Tailscale](https://tailscale.com) (gratis para uso personal):

```bash
# 1. En la PC: instalar y loguearse
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# 2. Publicar la app dentro de tu tailnet (HTTPS con certificado válido)
sudo tailscale serve --bg http://localhost:7777
tailscale serve status   # muestra la URL https://<maquina>.<tailnet>.ts.net
```

3. En el teléfono: instalá la app de Tailscale, logueate con la misma cuenta, y
   abrí la URL `https://...ts.net`. Desde ahí podés **instalarla como PWA**
   (Android: menú ⋮ → "Instalar app" · iOS: compartir → "Agregar a pantalla de
   inicio"). Funciona desde cualquier lugar del mundo, con la VPN de Tailscale
   activa en el teléfono.

4. **Si usás el dev server** (`npm run dev`), agregá tu hostname de Tailscale a
   `allowedDevOrigins` en `next.config.ts` (reemplazando el que está): el modo
   dev de Next bloquea sus recursos para hosts que no conoce y la app carga
   pero no responde (botones muertos). Con `npm start` (producción) no hace
   falta.

> ⚠️ **NUNCA expongas TaskApp a internet público sin autenticación** (port
> forwarding, túneles abiertos, etc.): la app no tiene login y puede lanzar
> workers con permisos totales en tu máquina — sería ejecución remota de
> código. Tailscale es seguro porque la URL solo existe dentro de tu red
> privada. Si necesitás una URL pública, poné un proxy con login adelante
> (p. ej. Cloudflare Tunnel + Cloudflare Access).

Para tenerla siempre disponible conviene el server de producción en vez del
dev server:

```bash
npm run build
npm start        # también en :7777
```

## Usar el CLI desde los loops

Instalá el comando `taskapp` en el PATH (una vez):

```bash
npm link         # deja `taskapp` global apuntando a este repo
```

…o invocá la ruta directa: `node /ruta/a/TaskApp/cli/taskapp.mjs`.

```bash
taskapp ensure-project --name "MiProyecto" --path "$(pwd)"
taskapp tasks --project "MiProyecto" --status todo,in_progress --json
taskapp update-task 3 --status done --stage develop
taskapp ask 3 "¿SQLite o Postgres?" --block
taskapp questions --task 3 --answered --json
taskapp help
```

## Conectar un proyecto

Copiá o symlinkeá la skill a cada proyecto:

```bash
mkdir -p /ruta/a/MiProyecto/.claude/skills
ln -s /ruta/a/TaskApp/skills/taskapp /ruta/a/MiProyecto/.claude/skills/taskapp
```

El loop de ese proyecto invoca la skill `taskapp` y sigue el protocolo.
