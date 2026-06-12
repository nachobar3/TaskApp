---
name: taskapp
description: Coordina este proyecto con la app local TaskApp. Usala cuando corras un loop de trabajo en un repo para leer las tareas que el humano creó, reportar progreso (status, stage develop/producción), hacerle preguntas al humano y leer sus respuestas. El humano administra todo desde la UI de TaskApp. El proyecto se detecta automáticamente por el directorio de trabajo.
---

# TaskApp — protocolo para loops

TaskApp es una app local donde el humano administra tareas por proyecto. Vos
(el loop) leés tareas, reportás progreso y le hacés preguntas. Todo pasa por el
CLI `taskapp`, que escribe en una base SQLite compartida con la UI
(`~/.taskapp/taskapp.db`). Funciona aunque la UI esté cerrada.

## Dos modos de ejecución

- **Loop interactivo** (una terminal con `/loop`): iterás indefinidamente; si
  hacés una pregunta quedás IDLE esperando la respuesta y la chequeás en cada
  iteración.
- **Worker efímero** (la app te lanzó con `claude -p`): procesás la cola y
  TERMINÁS. Diferencias con el loop interactivo:
  - Si hacés un `ask --block`, terminá tu ejecución inmediatamente — NO esperes
    la respuesta: cuando el humano responda en la UI, la app lanza otro worker
    que retoma.
  - Antes de terminar, volvé a chequear `taskapp tasks --status todo,in_progress`
    y `taskapp git-pending`: si entró trabajo nuevo mientras trabajabas,
    procesalo también. Terminás solo cuando no queda nada (o estás bloqueado).

## Asociación automática por directorio

**No tenés que pasar el nombre del proyecto.** El CLI detecta a qué proyecto
pertenece el directorio actual comparándolo con el `path` que el humano cargó en
la UI. Mientras corras parado dentro del repo (o un subdirectorio), todo resuelve
solo. Confirmá la asociación al empezar:

```bash
taskapp whoami
```

Si dice "ningún proyecto asociado", avisá al humano que cargue el `path` del
repo en la UI de TaskApp (debe apuntar a este directorio). No sigas hasta que
`whoami` devuelva un proyecto.

## Invocar el CLI

Si `taskapp` está en el PATH (el humano corrió `npm link` en el repo de TaskApp),
usalo directo. Si no, usá la ruta absoluta:

```bash
taskapp <cmd> ...
# o
node /home/ignacio/CodeProjects/TaskApp/cli/taskapp.mjs <cmd> ...
```

Agregá `--json` a cualquier comando de lectura para salida parseable.
Corré `taskapp help` para ver todos los comandos.

## Bucle de trabajo (cada iteración)

1. **Leé tus tareas pendientes** (proyecto inferido por el directorio):
   ```bash
   taskapp tasks --status todo,in_progress --json
   ```
   Cada tarea trae `id`, `title`, `body`, `status`, `stage`, `tested`,
   `document`, `open_questions` (preguntas tuyas sin responder),
   `open_followups` (pedidos posteriores del humano, ver abajo) y `attachments`
   (array de **rutas absolutas a imágenes** que el humano adjuntó).

   **Si la tarea trae `attachments`, abrí cada ruta con la herramienta Read
   antes de trabajar** — son capturas/imágenes que el humano sumó como contexto.
   (`taskapp show <id>` también las lista con el prefijo 📎.)

   **Si la tarea trae `open_followups`, es una CONTINUACIÓN**: una task que ya
   habías terminado y el humano reabrió pidiendo algo más *sobre esa misma
   tarea*. El contexto es el hilo completo — leelo con `taskapp show <id> --json`:
   body original, resumen de lo que ya se hizo, preguntas respondidas y los
   follow-ups (resueltos y pendientes). No la trates como tarea nueva: retomá
   sobre lo ya hecho y trabajá lo que piden los follow-ups pendientes.

2. **Tomá una tarea** y marcala en progreso:
   ```bash
   taskapp update-task <taskId> --status in_progress
   ```
   Mientras la trabajás (sobre todo si lleva varios pasos), emití un heartbeat
   cada tanto para que el humano vea en la UI que seguís activo en ella:
   ```bash
   taskapp heartbeat <taskId>
   ```

3. **Trabajá la tarea.** Si necesitás una decisión del humano, **BLOQUEATE y esperá**:
   - Hacé la pregunta (queda visible con badge en la UI). **Escribila en markdown
     y bien formateada** —se renderiza con formato en la app—: párrafos cortos,
     **negrita** en lo clave, y **listas** (`- ` o `1.`) cuando hay opciones o
     varios puntos. Evitá un párrafo gigante todo junto.
     ```bash
     taskapp ask <taskId> "¿**Postgres** o **SQLite**?\n\n- Postgres: …\n- SQLite: …" --block
     ```
     Para preguntas **largas o con backticks/comillas/URLs**, escribí el markdown
     en un archivo con tu herramienta Write y pasalo con `--text-file` (evita
     problemas de escaping en la shell):
     ```bash
     # escribís /tmp/taskapp-question.md con la pregunta formateada, después:
     taskapp ask <taskId> --text-file /tmp/taskapp-question.md --block
     ```
     `--block` marca la tarea como `blocked`.
   - **DETENETE: no inicies ninguna otra tarea mientras haya una pregunta sin
     responder.** El loop queda IDLE esperando la respuesta del humano. Esto es a
     propósito: no avances en paralelo.
   - En cada iteración, chequeá si ya te respondieron:
     ```bash
     taskapp questions --unanswered --json   # ¿sigue habiendo preguntas abiertas?
     taskapp questions --answered --json      # ¿ya respondió?
     ```
     Cuando aparezca la respuesta, desbloqueá y continuá esa misma tarea:
     ```bash
     taskapp update-task <taskId> --status in_progress
     ```
   - Solo cuando NO quede ninguna pregunta sin responder podés volver a tomar otras
     tareas.

4. **Al terminar**, marcá done **SIEMPRE con un resumen** (obligatorio). Escribí
   el resumen en un archivo con tu herramienta Write y pasalo con `--summary-file`
   (así evitás problemas de comillas/backticks en markdown largo):
   ```bash
   # 1) escribí /tmp/taskapp-summary.md con el resumen (ver plantilla abajo)
   # 2) marcá done con el resumen y el stage:
   taskapp done <taskId> --stage <local|develop|production> --summary-file /tmp/taskapp-summary.md
   ```
   Más adelante, cuando lo subas a otro entorno, actualizá solo el stage:
   ```bash
   taskapp update-task <taskId> --stage develop
   taskapp update-task <taskId> --stage production
   ```

   **Si la task tenía follow-ups pendientes**, el mismo `taskapp done` los
   resuelve: tu resumen queda como respuesta del follow-up en el hilo (y el
   resumen original de la task se preserva). Resumí solo lo que hiciste por el
   follow-up, no repitas lo anterior.

   **Plantilla del resumen** (markdown). Si **no** fue un bug, contá qué se hizo.
   Si **fue un bug**, usá esta estructura:
   ```markdown
   ## Qué se hizo
   <una o dos líneas>

   ### Bug
   - **Dónde**: archivo/función (ej. `src/auth/login.ts:42`, función `validate()`)
   - **Causa**: por qué pasaba
   - **Solución**: qué cambiaste para arreglarlo
   ```

   El `stage` (local / develop / production) lo manejás vos según dónde esté el
   código. El check **tested** lo tilda el humano en la UI, no vos.

5. Si descubrís trabajo nuevo que conviene registrar, podés crear tareas:
   ```bash
   taskapp add-task --title "Refactor del parser" --body "..."
   ```
   (Quedan marcadas como creadas por el loop.)

## Commits y push (lo pide el humano, lo ejecutás vos)

Una vez por iteración, revisá si el humano pidió trabajo de git:

```bash
taskapp git-pending --json
```

Devuelve `target_branch`, `push_requested`, y `tasks_to_commit` (tasks que el
humano marcó para commitear). Si no hay nada pendiente, no toques git.

**Para cada task en `tasks_to_commit`** (de la más vieja a la más nueva):
1. `git add -A` en el repo.
2. Si hay cambios staged, commiteá con el título de la task como asunto y el
   resumen como cuerpo. Usá un archivo de mensaje para no pelear con el escaping:
   ```bash
   # escribí /tmp/taskapp-commitmsg.txt con: "<título>\n\n<resumen>"
   git commit -F /tmp/taskapp-commitmsg.txt
   ```
   Si `git` dice "nothing to commit" (los cambios ya entraron en un commit
   anterior de esta misma tanda), no es error: usá el commit actual.
3. Tomá el hash y reportalo:
   ```bash
   taskapp mark-committed <taskId> --hash "$(git rev-parse HEAD)"
   ```

**Si `push_requested` es true**, después de commitear todo lo pendiente:
```bash
git push origin HEAD:<target_branch>     # ej. HEAD:develop
```
- Si sale bien: `taskapp mark-pushed`
- Si falla: `taskapp mark-pushed --error "<motivo corto>"` y, si la causa
  requiere una decisión mía (conflicto, credenciales), abrí un `taskapp ask`.

Nota: como git no separa archivos por tarea, el commit toma todo el working tree.
Por eso conviene que cada task se commitee apenas se termina; si hay varias
pendientes juntas, la primera se lleva los cambios y a las demás les asignás el
hash del commit que las incluyó.

## Reglas

- **SOLO trabajás en local.** Por tu cuenta NUNCA corras `git commit`, `git push`,
  `git merge` ni cambios de rama. Dejás los cambios en el working tree. **La ÚNICA
  excepción** es cuando el humano lo pide explícitamente desde la app: ahí seguís
  el procedimiento de "Commits y push" de abajo. Nunca commitees/pushees si no hay
  un pedido en `taskapp git-pending`. (`git status`/`git diff` para inspeccionar
  siempre está bien.)
- **Una pregunta sin responder bloquea el loop.** Cuando hacés un `ask`, no
  inicies otras tareas: quedás IDLE esperando la respuesta, y en cada iteración
  solo chequeás si ya te respondieron. Recién seguís con otras tareas cuando no
  queda ninguna pregunta abierta.
- Mantené `status` y `stage` actualizados: son las columnas que el humano ve.
- No toques el flag `tested` — es del humano.
- Una pregunta = un `ask`. Sé concreto para que la respuesta sea corta.
- Si no hay tareas `todo`/`in_progress`, no inventes trabajo: terminá la
  iteración (o esperá la próxima).

## Referencia rápida

| Acción | Comando |
|---|---|
| Confirmar proyecto | `taskapp whoami` |
| Leer tareas | `taskapp tasks --status todo,in_progress --json` |
| Ver una tarea | `taskapp show <id> --json` |
| Tomar tarea | `taskapp update-task <id> --status in_progress` |
| Sigo activo (heartbeat) | `taskapp heartbeat <id>` |
| Preguntar | `taskapp ask <id> "..." --block` |
| Ver respuestas | `taskapp questions --task <id> --answered --json` |
| Terminar (con resumen) | `taskapp done <id> --stage develop --summary-file <ruta>` |
| Crear tarea | `taskapp add-task --title "..."` |
