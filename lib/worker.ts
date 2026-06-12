// Ephemeral workers: the app spawns `claude -p` in a project's repo to drain
// its task queue, then the process exits. Re-triggered by events (new task,
// answered question, follow-up, git request) or manually from the UI.
//
// Guards: never two workers per project (live pid check); automatic triggers
// also skip projects where an interactive loop seems active (last_seen fresh
// with no worker pid recorded — i.e. a human-driven session in a terminal).

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getProject, pidAlive, setWorkerPid } from "./db";

// Same window the UI uses for the "prendido" indicator.
const INTERACTIVE_FRESH_MS = 8 * 60 * 1000;

const WORKER_PROMPT = `Sos un worker autónomo de TaskApp para este proyecto. Invocá la skill "taskapp" y seguí su protocolo, operando en modo worker efímero:

1. Corré \`taskapp whoami\` para confirmar el proyecto.
2. Procesá la cola: tareas en status todo/in_progress (\`taskapp tasks --status todo,in_progress --json\`). Una tarea con follow-ups abiertos es una CONTINUACIÓN: su hilo (body original, resumen previo, preguntas respondidas y los follow-ups) es tu contexto — leelo entero con \`taskapp show <id> --json\` antes de trabajar.
3. Atendé también \`taskapp git-pending\` según el protocolo.
4. Si necesitás una decisión del humano, hacé \`taskapp ask <id> ... --block\` y TERMINÁ tu ejecución inmediatamente: cuando el humano responda en la UI, otro worker va a arrancar y retomar. No esperes la respuesta vos.
5. Comandos largos (suites de tests, builds, seeds): corrélos en FOREGROUND y esperá el resultado en esta misma ejecución, prefijando un heartbeat (\`taskapp heartbeat <id>; <comando>\`). NUNCA dejes un proceso en background y termines "para esperar el resultado": el proceso muere con vos y nadie te relanza cuando termina. Si algo tarda 20 minutos, esperalo los 20 minutos.
6. Antes de terminar, volvé a chequear la cola (\`taskapp tasks --status todo,in_progress --json\` y \`taskapp git-pending\`): si entró trabajo nuevo mientras trabajabas, procesalo también.
7. Cuando no quede nada pendiente (o quedaste bloqueado en una pregunta), terminá. Nunca dejes una task in_progress sin un proceso tuyo trabajándola: o la terminás, o la bloqueás con un ask, o la devolvés a todo explicando en qué quedó.`;

function logsDir(): string {
  const dir = path.join(
    path.dirname(process.env.TASKAPP_DB || path.join(os.homedir(), ".taskapp", "db")),
    "logs"
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export interface StartResult {
  started: boolean;
  reason: string;
  pid?: number;
}

/**
 * Spawn a worker for the project if appropriate. `manual` (UI button) skips
 * the auto_worker flag and the interactive-loop guard; the live-pid guard
 * always applies.
 */
export function maybeStartWorker(
  projectId: number,
  opts: { manual?: boolean } = {}
): StartResult {
  const p = getProject(projectId);
  if (!p) return { started: false, reason: "proyecto inexistente" };
  if (!p.path || !fs.existsSync(p.path))
    return { started: false, reason: "el proyecto no tiene path válido" };

  if (pidAlive(p.worker_pid))
    return { started: false, reason: "ya hay un worker corriendo" };

  if (!opts.manual) {
    if (!p.auto_worker) return { started: false, reason: "auto worker apagado" };
    // No pid on record but the CLI was seen recently → likely an interactive
    // loop in a terminal; let it pick the work up instead of doubling it.
    const seenMs = p.last_seen
      ? Date.now() - new Date(p.last_seen.replace(" ", "T") + "Z").getTime()
      : Infinity;
    if (!p.worker_pid && seenMs < INTERACTIVE_FRESH_MS)
      return { started: false, reason: "hay un loop interactivo activo" };
  }

  const bin = process.env.TASKAPP_CLAUDE_BIN || "claude";
  const logFile = path.join(logsDir(), `${p.id}-${p.name.replace(/[^\w.-]+/g, "_")}.log`);
  const fd = fs.openSync(logFile, "a");
  fs.writeSync(
    fd,
    `\n===== worker ${new Date().toISOString()} (${opts.manual ? "manual" : "auto"}) =====\n`
  );

  try {
    const child = spawn(
      bin,
      ["--dangerously-skip-permissions", "-p", WORKER_PROMPT],
      {
        cwd: p.path,
        detached: true,
        stdio: ["ignore", fd, fd],
        env: process.env,
      }
    );
    child.unref();
    if (!child.pid) return { started: false, reason: "spawn sin pid" };
    setWorkerPid(p.id, child.pid);
    return { started: true, reason: "worker lanzado", pid: child.pid };
  } catch (e) {
    return {
      started: false,
      reason: `no pude lanzar claude: ${e instanceof Error ? e.message : e}`,
    };
  } finally {
    fs.closeSync(fd);
  }
}
