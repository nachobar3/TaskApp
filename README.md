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
npm run dev      # http://localhost:3000
```

La base se crea sola en `~/.taskapp/taskapp.db` (o donde apunte `$TASKAPP_DB`).

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
