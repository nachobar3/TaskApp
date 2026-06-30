"use client";

import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  DocumentView,
  ProjectBranchView,
  ProjectView,
  Stage,
  TaskView,
  openQuestionCount,
} from "@/lib/types";
import { DEFAULT_WORKER_MODEL, WORKER_MODELS } from "@/lib/models";

const STAGE_STYLE: Record<Stage, string> = {
  local: "bg-zinc-800 text-zinc-300 border-zinc-700",
  develop: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  production: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
};

const INPUT =
  "w-full px-2.5 py-1.5 rounded-md bg-zinc-800/70 border border-zinc-700 text-zinc-100 placeholder-zinc-500 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/40";

// A task counts as "actively being worked on" if it's in_progress and the loop
// pinged it within this window.
const WORKING_FRESH_MS = 5 * 60 * 1000;

// Un proyecto que el loop tocó alguna vez (tiene `last_seen`) se mantiene
// "prendido" indefinidamente —para recordar en qué estabas trabajando aunque
// quede idle— hasta que lo apagues a mano desde la UI (powered_off_at). Apagarlo
// no es permanente: si el loop vuelve a registrar actividad (last_seen más
// reciente que el apagado) o lo encendés a mano, vuelve a prenderse.
function projectPoweredOff(p: ProjectView): boolean {
  if (!p.powered_off_at) return false;
  if (!p.last_seen) return true;
  return parseUTC(p.powered_off_at) >= parseUTC(p.last_seen);
}

// SQLite stores timestamps as "YYYY-MM-DD HH:MM:SS" in UTC (no tz marker).
function parseUTC(ts: string): number {
  return new Date(ts.replace(" ", "T") + "Z").getTime();
}
function timeAgo(ts: string, now: number): string {
  const s = Math.max(0, Math.floor((now - parseUTC(ts)) / 1000));
  if (s < 60) return `hace ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h}h`;
  return `hace ${Math.floor(h / 24)}d`;
}

// Timestamp (epoch ms) de la última "respuesta" que emitió el loop en una task:
// si la creó el loop, si la terminó con resumen, o preguntas que hizo. Sirve
// para detectar novedades del loop que el humano todavía no miró.
function taskLoopActivityAt(t: TaskView): number {
  let max = 0;
  if (t.created_by === "loop") max = Math.max(max, parseUTC(t.created_at));
  if (t.status === "done" && t.summary) max = Math.max(max, parseUTC(t.updated_at));
  for (const q of t.questions) max = Math.max(max, parseUTC(q.created_at));
  for (const f of t.followups)
    if (f.resolved_at) max = Math.max(max, parseUTC(f.resolved_at));
  return max;
}

// Lo mismo a nivel proyecto: la novedad más reciente del loop en cualquier task.
function loopActivityAt(p: ProjectView): number {
  let max = 0;
  for (const d of p.documents)
    for (const t of d.tasks) max = Math.max(max, taskLoopActivityAt(t));
  return max;
}

// "Visto": epoch ms por id (proyecto abierto / task expandida). Persiste en
// localStorage para que las novedades sobrevivan reloads.
type SeenMap = Record<number, number>;
const PROJECT_SEEN_KEY = "taskapp:loopSeen";
const TASK_SEEN_KEY = "taskapp:loopSeenTasks";
const FIRSTRUN_KEY = "taskapp:firstRunAt";
function loadSeen(key: string): SeenMap {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(key) || "{}") as SeenMap;
  } catch {
    return {};
  }
}
function persistSeen(key: string, s: SeenMap) {
  try {
    localStorage.setItem(key, JSON.stringify(s));
  } catch {
    /* localStorage no disponible: las novedades no persisten, no es crítico */
  }
}

// Marca temporal de la primera vez que se abrió la app (se persiste y nunca
// cambia). Las novedades del loop anteriores a este instante no se marcan, así
// no inundamos de ✦ todo el historial preexistente. Novedades posteriores que
// no abriste sí se marcan (aunque hayan llegado con la app cerrada).
function firstRunAt(): number {
  if (typeof window === "undefined") return 0;
  try {
    let v = Number(localStorage.getItem(FIRSTRUN_KEY));
    if (!v) {
      v = Date.now();
      localStorage.setItem(FIRSTRUN_KEY, String(v));
    }
    return v;
  } catch {
    return 0;
  }
}

// Logo: checklist (tareas tildadas) sobre el gradiente de la marca.
function TasksLogo({ box, icon }: { box: string; icon: string }) {
  return (
    <span
      className={`${box} bg-gradient-to-br from-indigo-500 to-fuchsia-500 flex items-center justify-center text-white shadow-lg shadow-indigo-500/20`}
    >
      <svg
        className={icon}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="m3 7 2 2 4-4" />
        <path d="M13 6h8" />
        <path d="M13 12h8" />
        <path d="m3 17 2 2 4-4" />
        <path d="M13 18h8" />
      </svg>
    </span>
  );
}

async function api(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `${method} ${url} failed`);
  }
  return res.json().catch(() => ({}));
}

async function uploadAttachment(taskId: number, file: File, questionId?: number) {
  const fd = new FormData();
  fd.append("file", file);
  if (questionId) fd.append("question_id", String(questionId));
  const res = await fetch(`/api/tasks/${taskId}/attachments`, {
    method: "POST",
    body: fd,
  });
  if (!res.ok) throw new Error("upload failed");
}

interface PendingImage {
  key: string;
  file: File;
  url: string;
}

function imagesFromTransfer(
  list: FileList | null | undefined
): { file: File; url: string }[] {
  if (!list) return [];
  return Array.from(list)
    .filter((f) => f.type.startsWith("image/"))
    .map((file) => ({ file, url: URL.createObjectURL(file) }));
}

export default function Home() {
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [selectedProject, setSelectedProject] = useState<number | null>(null);
  const [selectedDoc, setSelectedDoc] = useState<number | null>(null);
  // Drawer del sidebar en mobile (en md+ el sidebar es columna fija).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [seen, setSeen] = useState<SeenMap>(() => loadSeen(PROJECT_SEEN_KEY));
  const [taskSeen, setTaskSeen] = useState<SeenMap>(() => loadSeen(TASK_SEEN_KEY));
  const [firstRun] = useState(firstRunAt);
  const prevOpen = useRef(0);

  // Una task tiene novedad del loop sin ver si el loop la tocó después de la
  // última vez que la expandiste (o, si nunca la abriste, después del primer uso
  // de la app). Se omite si tiene preguntas abiertas: esas ya gritan en rojo.
  const isTaskUnseen = useCallback(
    (t: TaskView) =>
      t.questions.every((q) => q.answered) &&
      taskLoopActivityAt(t) > (taskSeen[t.id] ?? firstRun),
    [taskSeen, firstRun]
  );
  const markTaskSeen = useCallback((taskId: number) => {
    setTaskSeen((prev) => {
      const next = { ...prev, [taskId]: Date.now() };
      persistSeen(TASK_SEEN_KEY, next);
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    const data = await api("/api/state", "GET");
    const next: ProjectView[] = data.projects;
    setProjects(next);

    // Browser notification when the number of open questions grows.
    const totalOpen = next.reduce((n, p) => n + openQuestionCount(p), 0);
    if (
      totalOpen > prevOpen.current &&
      typeof Notification !== "undefined" &&
      Notification.permission === "granted"
    ) {
      new Notification("TaskApp", {
        body: `Tenés ${totalOpen} pregunta(s) sin responder`,
      });
    }
    prevOpen.current = totalOpen;
    return next;
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 2000);
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission();
    }
    return () => clearInterval(t);
  }, [load]);

  // Keep a valid selection as data arrives.
  useEffect(() => {
    if (projects.length === 0) {
      setSelectedProject(null);
      return;
    }
    if (selectedProject === null || !projects.find((p) => p.id === selectedProject)) {
      setSelectedProject(projects[0].id);
    }
  }, [projects, selectedProject]);

  const project = projects.find((p) => p.id === selectedProject) ?? null;

  useEffect(() => {
    if (!project) return;
    if (selectedDoc === null || !project.documents.find((d) => d.id === selectedDoc)) {
      setSelectedDoc(project.documents[0]?.id ?? null);
    }
  }, [project, selectedDoc]);

  const doc = project?.documents.find((d) => d.id === selectedDoc) ?? null;

  // Marca de "visto": proyectos nuevos arrancan al día (no marcamos como novedad
  // todo el historial viejo), y el proyecto abierto se mantiene visto mientras lo
  // mirás (cada poll), así una respuesta del loop solo es "sin ver" si llegó
  // mientras estabas en otro proyecto.
  useEffect(() => {
    setSeen((prev) => {
      const next = { ...prev };
      const now = Date.now();
      let changed = false;
      for (const p of projects) {
        if (next[p.id] == null) {
          next[p.id] = now;
          changed = true;
        }
      }
      if (selectedProject != null) {
        next[selectedProject] = now;
        changed = true;
      }
      if (changed) persistSeen(PROJECT_SEEN_KEY, next);
      return changed ? next : prev;
    });
  }, [projects, selectedProject]);

  const totalOpenQuestions = projects.reduce((n, p) => n + openQuestionCount(p), 0);

  return (
    <div className="flex h-dvh flex-col md:flex-row text-[0.8125rem] sm:text-sm text-zinc-300">
      {/* Top bar — solo mobile */}
      <header className="md:hidden shrink-0 flex items-center gap-2.5 px-3 py-2.5 border-b border-zinc-800/80 bg-zinc-900">
        <button
          onClick={() => setSidebarOpen(true)}
          className="relative p-1.5 -ml-1 rounded-md text-zinc-300 hover:bg-zinc-800"
          aria-label="Abrir proyectos"
        >
          <svg
            className="h-5 w-5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
          {totalOpenQuestions > 0 && (
            <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-rose-500" />
          )}
        </button>
        <TasksLogo box="h-6 w-6 rounded-md" icon="h-3.5 w-3.5" />
        <span className="font-semibold text-zinc-100 truncate">
          {project?.name ?? "TaskApp"}
        </span>
      </header>

      {/* Backdrop del drawer */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar: drawer deslizable en mobile, columna fija en md+ */}
      <div
        className={`${
          sidebarOpen ? "flex" : "hidden"
        } md:flex fixed inset-y-0 left-0 z-40 md:static md:z-auto`}
      >
        <Sidebar
          projects={projects}
          selected={selectedProject}
          seen={seen}
          onSelect={(id) => {
            setSelectedProject(id);
            setSelectedDoc(null);
            setSidebarOpen(false);
          }}
          reload={load}
        />
      </div>

      <main className="flex-1 overflow-y-auto bg-zinc-950">
        {!project ? (
          <Empty />
        ) : (
          <ProjectPanel
            key={project.id}
            project={project}
            doc={doc}
            onSelectDoc={setSelectedDoc}
            reload={load}
            isTaskUnseen={isTaskUnseen}
            markTaskSeen={markTaskSeen}
          />
        )}
      </main>
    </div>
  );
}

function ProjectButton({
  p,
  active,
  on,
  unseen,
  now,
  onSelect,
}: {
  p: ProjectView;
  active: boolean;
  on: boolean;
  unseen: boolean;
  now: number;
  onSelect: (id: number) => void;
}) {
  const open = openQuestionCount(p);
  const waiting = open > 0; // esperando que el humano responda una pregunta
  return (
    <button
      onClick={() => onSelect(p.id)}
      className={`w-full text-left px-3 py-2 rounded-lg flex items-center gap-2 transition-colors ${
        active
          ? waiting
            ? "bg-rose-600 text-white shadow-md shadow-rose-600/20"
            : "bg-indigo-600 text-white shadow-md shadow-indigo-600/20"
          : waiting
            ? "bg-rose-950/40 text-rose-200 hover:bg-rose-950/60"
            : on
              ? "text-zinc-300 hover:bg-zinc-800"
              : "text-zinc-500 opacity-70 hover:bg-zinc-800/60 hover:opacity-100"
      }`}
    >
      {waiting ? (
        <span className="relative flex h-2 w-2 shrink-0" title="Esperando tu respuesta">
          <span className="absolute inline-flex h-full w-full rounded-full bg-rose-500 opacity-75 animate-ping" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-rose-500" />
        </span>
      ) : on ? (
        <span className="relative flex h-2 w-2 shrink-0" title="Loop activo">
          <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
        </span>
      ) : (
        <span
          className="h-2 w-2 shrink-0 rounded-full bg-zinc-600"
          title={p.last_seen ? `loop visto ${timeAgo(p.last_seen, now)}` : "sin actividad del loop"}
        />
      )}
      <span className="truncate flex-1">{p.name}</span>
      {unseen && (
        <span
          className="shrink-0 inline-flex items-center gap-1 text-[0.625rem] px-1.5 py-0.5 rounded-full border border-sky-400/40 bg-sky-500/20 text-sky-200"
          title="El loop dejó respuestas/novedades que todavía no viste"
        >
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75 animate-ping" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-sky-400" />
          </span>
          ✦
        </span>
      )}
      {waiting && (
        <span
          className={`shrink-0 min-w-5 h-5 px-1.5 rounded-full text-xs font-medium flex items-center justify-center ${
            active ? "bg-white text-rose-700" : "bg-rose-500 text-white"
          }`}
          title="Preguntas sin responder"
        >
          {open}
        </span>
      )}
    </button>
  );
}

function Sidebar({
  projects,
  selected,
  seen,
  onSelect,
  reload,
}: {
  projects: ProjectView[];
  selected: number | null;
  seen: SeenMap;
  onSelect: (id: number) => void;
  reload: () => Promise<unknown>;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const now = Date.now();

  async function create() {
    if (!name.trim()) return;
    await api("/api/projects", "POST", { name, path });
    setName("");
    setPath("");
    setAdding(false);
    await reload();
  }

  // El loop dejó novedades sin ver: produjo actividad después de la última vez
  // que abriste el proyecto. Se omite si hay preguntas abiertas (esas ya gritan
  // en rojo con su propio indicador).
  const isUnseen = (p: ProjectView) =>
    openQuestionCount(p) === 0 &&
    loopActivityAt(p) > (seen[p.id] ?? Number.MAX_SAFE_INTEGER);

  // "Prendido": worker corriendo, con preguntas abiertas, con una novedad del
  // loop que no miraste, o que el loop tocó alguna vez y no lo apagaste a mano.
  // Ya NO se apaga solo por inactividad: queda prendido hasta que lo apagues.
  // Las señales de atención (worker/preguntas/novedades) lo mantienen arriba
  // aunque esté apagado a mano —no tiene sentido ocultar algo que te reclama.
  const isActive = (p: ProjectView) =>
    p.worker_running ||
    openQuestionCount(p) > 0 ||
    isUnseen(p) ||
    (!!p.last_seen && !projectPoweredOff(p));
  // Projects waiting for an answer bubble to the top of their group.
  const waitingFirst = (a: ProjectView, b: ProjectView) =>
    (openQuestionCount(b) > 0 ? 1 : 0) - (openQuestionCount(a) > 0 ? 1 : 0);
  const on = projects.filter(isActive).sort(waitingFirst);
  const off = projects.filter((p) => !isActive(p)).sort(waitingFirst);

  // Ctrl/⌘ + ↑/↓ cicla entre proyectos siguiendo el orden visual del sidebar
  // (primero los prendidos, después los apagados). El ref se mantiene fresco vía
  // effect para no re-suscribir el listener en cada poll.
  const orderedIds = [...on, ...off].map((p) => p.id);
  const navRef = useRef({
    order: [] as number[],
    selected: null as number | null,
    onSelect,
  });
  useEffect(() => {
    navRef.current = { order: orderedIds, selected, onSelect };
  });
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      const { order, selected, onSelect } = navRef.current;
      if (order.length === 0) return;
      e.preventDefault();
      const idx = selected == null ? -1 : order.indexOf(selected);
      if (idx === -1) {
        onSelect(order[0]);
        return;
      }
      const delta = e.key === "ArrowDown" ? 1 : -1;
      onSelect(order[(idx + delta + order.length) % order.length]);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <aside className="w-64 shrink-0 border-r border-zinc-800/80 bg-zinc-900 flex flex-col">
      <div className="px-4 py-3.5 border-b border-zinc-800/80 flex items-center gap-2.5">
        <TasksLogo box="h-7 w-7 rounded-lg" icon="h-4 w-4" />
        <div>
          <h1 className="font-semibold text-zinc-100 leading-tight">TaskApp</h1>
          <p className="text-[0.6875rem] text-zinc-500 leading-tight">
            Control de loops de Claude
          </p>
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto p-2 space-y-1">
        {on.map((p) => (
          <ProjectButton
            key={p.id}
            p={p}
            active={selected === p.id}
            on={true}
            unseen={isUnseen(p)}
            now={now}
            onSelect={onSelect}
          />
        ))}

        {off.length > 0 && (
          <div className="px-3 pt-3 pb-1 text-[0.625rem] uppercase tracking-wide text-zinc-600 flex items-center gap-2">
            Apagados
            <span className="flex-1 h-px bg-zinc-800" />
          </div>
        )}
        {off.map((p) => (
          <ProjectButton
            key={p.id}
            p={p}
            active={selected === p.id}
            on={false}
            unseen={isUnseen(p)}
            now={now}
            onSelect={onSelect}
          />
        ))}

        {projects.length === 0 && (
          <p className="px-3 py-2 text-xs text-zinc-600">Sin proyectos todavía.</p>
        )}
      </nav>
      <div className="p-2 border-t border-zinc-800/80">
        {adding ? (
          <div className="space-y-2">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nombre del proyecto"
              className={INPUT}
              onKeyDown={(e) => e.key === "Enter" && create()}
            />
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="Ruta (opcional)"
              className={INPUT}
            />
            <div className="flex gap-2">
              <button
                onClick={create}
                className="flex-1 px-2 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition-colors"
              >
                Crear
              </button>
              <button
                onClick={() => setAdding(false)}
                className="px-2.5 py-1.5 rounded-md border border-zinc-700 text-zinc-400 hover:bg-zinc-800"
              >
                ✕
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setAdding(true)}
            className="w-full px-3 py-2 rounded-lg border border-dashed border-zinc-700 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
          >
            + Proyecto
          </button>
        )}
      </div>
    </aside>
  );
}

// Diálogo modal acorde al diseño de la app, en reemplazo de los nativos del
// browser (confirm/alert). Promise-based: `confirm()` resuelve a boolean,
// `alert()` a void. Esc/backdrop cancelan, Enter confirma.
type DialogVariant = "default" | "danger";
type DialogRequest = {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: DialogVariant;
};
type DialogState = DialogRequest & {
  kind: "confirm" | "alert";
  resolve: (ok: boolean) => void;
};

function DialogModal({
  state,
  onClose,
}: {
  state: DialogState;
  onClose: (ok: boolean) => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const danger = state.variant === "danger";
  const showCancel = state.kind === "confirm";

  useEffect(() => {
    confirmRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose(false);
      else if (e.key === "Enter") onClose(true);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={() => onClose(false)}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl shadow-black/40"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5">
          {state.title && (
            <h3 className="text-base font-semibold text-zinc-100 mb-2">
              {state.title}
            </h3>
          )}
          <p className="text-sm text-zinc-300 whitespace-pre-line leading-relaxed">
            {state.message}
          </p>
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-zinc-800">
          {showCancel && (
            <button
              onClick={() => onClose(false)}
              className="px-3 py-1.5 rounded-md text-sm text-zinc-300 border border-zinc-700 hover:bg-zinc-800 transition-colors"
            >
              {state.cancelLabel ?? "Cancelar"}
            </button>
          )}
          <button
            ref={confirmRef}
            onClick={() => onClose(true)}
            className={`px-3 py-1.5 rounded-md text-sm font-medium text-white transition-colors ${
              danger
                ? "bg-rose-600 hover:bg-rose-500"
                : "bg-indigo-600 hover:bg-indigo-500"
            }`}
          >
            {state.confirmLabel ?? (showCancel ? "Confirmar" : "Entendido")}
          </button>
        </div>
      </div>
    </div>
  );
}

// Hook: devuelve `confirm`/`alert` (promise-based) y el elemento `dialog` para
// montar en el árbol. Maneja un único diálogo a la vez.
function useDialog() {
  const [state, setState] = useState<DialogState | null>(null);

  const confirm = useCallback(
    (req: DialogRequest) =>
      new Promise<boolean>((resolve) =>
        setState({ ...req, kind: "confirm", resolve })
      ),
    []
  );
  const alert = useCallback(
    (req: DialogRequest) =>
      new Promise<void>((resolve) =>
        setState({ ...req, kind: "alert", resolve: () => resolve() })
      ),
    []
  );
  const close = useCallback(
    (ok: boolean) =>
      setState((s) => {
        s?.resolve(ok);
        return null;
      }),
    []
  );

  const dialog = state ? <DialogModal state={state} onClose={close} /> : null;
  return { confirm, alert, dialog };
}

// Editor del proceso de promoción de un destino: cómo el worker entrega el
// código a esa rama. Cada repo diseña el suyo (push directo / merge / PR) y
// todos se disparan con el mismo botón de la barra. Las notas son
// instrucciones libres que el worker sigue al pie (pasos extra, checks, etc.).
function BranchPromotionEditor({
  branch,
  remoteBranches,
  onSave,
}: {
  branch: ProjectBranchView;
  remoteBranches: string[] | null;
  onSave: (fields: {
    promote_strategy: string;
    promote_from: string | null;
    promote_notes: string | null;
  }) => void | Promise<unknown>;
}) {
  // El componente persiste entre los reloads del poll (key = branch.id), así que
  // el estado local del textarea sobrevive sin pisar lo que estás tipeando.
  const [notes, setNotes] = useState(branch.promote_notes ?? "");

  const strategy = branch.promote_strategy || "push";
  const needsSource = strategy === "merge" || strategy === "pr";
  // Opciones de rama origen: las del remoto menos la propia rama destino.
  const sourceOptions = (remoteBranches ?? []).filter((b) => b !== branch.branch);

  function save(next: {
    promote_strategy?: string;
    promote_from?: string | null;
    promote_notes?: string | null;
  }) {
    onSave({
      promote_strategy: next.promote_strategy ?? strategy,
      promote_from:
        next.promote_from !== undefined ? next.promote_from : branch.promote_from,
      promote_notes:
        next.promote_notes !== undefined
          ? next.promote_notes
          : branch.promote_notes,
    });
  }

  return (
    <div className="flex flex-col gap-1.5 pl-1 text-[0.7rem]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-zinc-500">proceso a prod</span>
        <select
          value={strategy}
          onChange={(e) => save({ promote_strategy: e.target.value })}
          className="px-1.5 py-0.5 rounded border border-zinc-700 bg-zinc-800/70 text-zinc-200 outline-none cursor-pointer"
          title="Cómo el worker entrega el código a esta rama"
        >
          <option value="push">push directo</option>
          <option value="merge">merge de otra rama</option>
          <option value="pr">PR (pull request)</option>
        </select>
        {needsSource &&
          (sourceOptions.length > 0 ? (
            <>
              <span className="text-zinc-600">desde</span>
              <select
                value={branch.promote_from ?? ""}
                onChange={(e) =>
                  save({ promote_from: e.target.value || null })
                }
                className="px-1.5 py-0.5 rounded border border-zinc-700 bg-zinc-800/70 text-zinc-200 font-mono outline-none cursor-pointer"
                title="Rama origen del merge/PR"
              >
                <option value="">(elegí rama origen)</option>
                {/* La rama guardada puede no estar en el remoto leído: mostrala igual */}
                {branch.promote_from &&
                  !sourceOptions.includes(branch.promote_from) && (
                    <option value={branch.promote_from}>
                      {branch.promote_from}
                    </option>
                  )}
                {sourceOptions.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <>
              <span className="text-zinc-600">desde</span>
              <input
                defaultValue={branch.promote_from ?? ""}
                onBlur={(e) =>
                  save({ promote_from: e.target.value.trim() || null })
                }
                placeholder="rama origen (ej. develop)"
                className="px-1.5 py-0.5 rounded border border-zinc-700 bg-zinc-800/70 text-zinc-200 font-mono outline-none focus:border-indigo-500 w-40"
              />
            </>
          ))}
        {needsSource && !branch.promote_from && (
          <span className="text-amber-400" title="Falta la rama origen">
            ⚠ falta rama origen
          </span>
        )}
      </div>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        onBlur={() => {
          const v = notes.trim();
          if (v !== (branch.promote_notes ?? "")) save({ promote_notes: v || null });
        }}
        placeholder="instrucciones extra para el worker (opcional): pasos, checks, a quién pedir aprobación…"
        rows={2}
        className="w-full px-2 py-1 rounded border border-zinc-800 bg-zinc-900/50 text-zinc-300 placeholder-zinc-600 outline-none focus:border-indigo-500 resize-y"
      />
    </div>
  );
}

function ProjectPanel({
  project,
  doc,
  onSelectDoc,
  reload,
  isTaskUnseen,
  markTaskSeen,
}: {
  project: ProjectView;
  doc: DocumentView | null;
  onSelectDoc: (id: number) => void;
  reload: () => Promise<unknown>;
  isTaskUnseen: (t: TaskView) => boolean;
  markTaskSeen: (taskId: number) => void;
}) {
  const [addingDoc, setAddingDoc] = useState(false);
  const [docName, setDocName] = useState("");
  const [editingDest, setEditingDest] = useState(false);
  const [newBranch, setNewBranch] = useState("");
  const [newStage, setNewStage] = useState<"develop" | "production">("production");
  // Ramas reales del remoto del proyecto (se cargan desde git al abrir el
  // editor). El humano elige el destino de esta lista en vez de tipearlo, así
  // ve cómo se llaman de verdad las ramas de prod/dev en GitHub.
  const [remote, setRemote] = useState<{
    branches: string[];
    remote: string | null;
    error: string | null;
  } | null>(null);
  const [loadingRemote, setLoadingRemote] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const { confirm, alert, dialog } = useDialog();
  const now = Date.now();

  const tasksToCommit = project.documents
    .flatMap((d) => d.tasks)
    .filter((t) => t.commit_requested).length;

  // Done tasks not yet committed (nor archived) — candidates for "commit all".
  const tasksCommittable = project.documents
    .flatMap((d) => d.tasks)
    .filter(
      (t) =>
        t.status === "done" &&
        !t.commit_hash &&
        !t.archived &&
        !t.commit_requested
    ).length;

  // Destino de push activo y su proceso de promoción (cómo el worker entrega
  // el código a esa rama). Determina el verbo del botón: push / promover / PR.
  const activeDest = project.branches.find(
    (b) => b.branch === project.target_branch
  );
  const promoteStrategy = activeDest?.promote_strategy ?? "push";
  const promoteFrom = activeDest?.promote_from ?? null;
  const pushVerb =
    promoteStrategy === "merge"
      ? `⬆ Promover ${promoteFrom ?? "?"} → ${project.target_branch}`
      : promoteStrategy === "pr"
        ? `⬆ PR ${promoteFrom ?? "?"} → ${project.target_branch}`
        : `⬆ Push a ${project.target_branch} (→ ${project.push_stage})`;

  // Cartel "último push": ok (zinc) · error (rojo) · confirm (ámbar, decisión).
  const pushKind = project.push_status?.startsWith("error")
    ? "error"
    : project.push_status?.startsWith("confirm")
      ? "confirm"
      : "ok";
  // Texto sin el prefijo "error:"/"confirm:" para el cartel ámbar/rojo.
  const pushStatusBody = project.push_status?.replace(/^(error|confirm):\s*/, "");

  async function createDoc() {
    if (!docName.trim()) return;
    await api("/api/documents", "POST", { project_id: project.id, name: docName });
    setDocName("");
    setAddingDoc(false);
    await reload();
  }

  async function removeProject() {
    const ok = await confirm({
      title: "Borrar proyecto",
      message: `Se va a borrar "${project.name}" y todo su contenido. Esta acción no se puede deshacer.`,
      confirmLabel: "Borrar",
      variant: "danger",
    });
    if (!ok) return;
    await api(`/api/projects/${project.id}`, "DELETE");
    await reload();
  }

  // Pick one of the configured branch → stage destinations as the active one.
  async function selectDest(branch: string, stage: string) {
    if (branch === project.target_branch && stage === project.push_stage) return;
    await api(`/api/projects/${project.id}`, "PATCH", {
      target_branch: branch,
      push_stage: stage,
    });
    await reload();
  }

  // Trae las ramas reales del remoto del proyecto (git ls-remote vía la API) y
  // preselecciona la primera que todavía no es un destino guardado.
  async function loadRemote() {
    setLoadingRemote(true);
    try {
      const r = (await api(
        `/api/projects/${project.id}/branches`,
        "GET"
      )) as { branches: string[]; remote: string | null; error: string | null };
      setRemote(r);
      const taken = new Set(project.branches.map((b) => b.branch));
      const firstFree = r.branches.find((b) => !taken.has(b));
      setNewBranch(firstFree ?? r.branches[0] ?? "");
    } catch (e) {
      setRemote({
        branches: [],
        remote: null,
        error: e instanceof Error ? e.message : "no se pudieron leer las ramas",
      });
    } finally {
      setLoadingRemote(false);
    }
  }

  // Abrir/cerrar el editor de destinos; al abrir, carga las ramas del remoto.
  function toggleEditingDest() {
    setEditingDest((v) => {
      const next = !v;
      if (next && !remote && !loadingRemote) loadRemote();
      return next;
    });
  }

  async function addDest(branch?: string, stage?: "develop" | "production") {
    const b = (branch ?? newBranch).trim();
    const s = stage ?? newStage;
    if (!b) return;
    await api(`/api/projects/${project.id}/branches`, "POST", {
      branch: b,
      stage: s,
    });
    // Si tocás el stage del destino activo, sincronizá el push_stage del
    // proyecto para que la barra no quede desfasada.
    if (b === project.target_branch && s !== project.push_stage) {
      await selectDest(b, s);
    }
    await reload();
  }

  async function removeDest(branchId: number) {
    try {
      await api(`/api/projects/${project.id}/branches`, "DELETE", {
        branch_id: branchId,
      });
    } catch (e) {
      await alert({
        title: "No se pudo borrar el destino",
        message: e instanceof Error ? e.message : "Error desconocido",
        variant: "danger",
      });
    }
    await reload();
  }

  async function requestPush() {
    const proc =
      promoteStrategy === "merge"
        ? `Proceso: MERGE ${promoteFrom ?? "?"} → ${project.target_branch} y push.`
        : promoteStrategy === "pr"
          ? `Proceso: abrir PR ${promoteFrom ?? "?"} → ${project.target_branch} (el merge final lo confirmás vos).`
          : `Proceso: push directo a ${project.target_branch}.`;
    const ok = await confirm({
      title:
        promoteStrategy === "push" ? "Pedir push" : "Promover a producción",
      message: `Destino "${project.target_branch}" (las tasks pasan a stage "${project.push_stage}").\n\n${proc}\n\nEl loop, en su próxima iteración, va a commitear las tasks marcadas (${tasksToCommit}) y ejecutar el proceso configurado.`,
      confirmLabel: promoteStrategy === "pr" ? "Abrir PR" : "Promover",
    });
    if (!ok) return;
    await api(`/api/projects/${project.id}/push-request`, "POST", {});
    await reload();
  }

  async function commitAll() {
    if (tasksCommittable === 0) return;
    const ok = await confirm({
      title: "Commit all",
      message: `Marcar para commit las ${tasksCommittable} task(s) hechas, no commiteadas y no archivadas.\n\nUn worker las va a commitear en local (sin pushear).`,
      confirmLabel: "Commitear",
    });
    if (!ok) return;
    await api(`/api/projects/${project.id}/commit-all`, "POST", {});
    await reload();
  }

  async function cancelPush() {
    await api(`/api/projects/${project.id}/push-request`, "POST", { requested: false });
    await reload();
  }

  // Descarta el cartel "último push" (un needs-confirm/error que quedó fijo).
  async function dismissPushStatus() {
    await api(`/api/projects/${project.id}`, "PATCH", { clear_push_status: true });
    await reload();
  }

  // Guarda el proceso de promoción de un destino (cómo el worker entrega el
  // código a esa rama): estrategia + rama origen + instrucciones libres.
  async function savePromotion(
    branchId: number,
    fields: {
      promote_strategy: string;
      promote_from: string | null;
      promote_notes: string | null;
    }
  ) {
    await api(`/api/projects/${project.id}/branches`, "PATCH", {
      branch_id: branchId,
      ...fields,
    });
    await reload();
  }

  async function toggleAutoWorker() {
    await api(`/api/projects/${project.id}`, "PATCH", {
      auto_worker: !project.auto_worker,
    });
    await reload();
  }

  async function togglePowered() {
    await api(`/api/projects/${project.id}`, "PATCH", {
      powered_off: !projectPoweredOff(project),
    });
    await reload();
  }

  async function runWorkerNow() {
    try {
      await api(`/api/projects/${project.id}/worker`, "POST", {});
    } catch (e) {
      await alert({
        title: "No se pudo lanzar el worker",
        message: e instanceof Error ? e.message : "Error desconocido",
        variant: "danger",
      });
    }
    await reload();
  }

  async function saveWorkerModel(model: string) {
    await api(`/api/projects/${project.id}`, "PATCH", { worker_model: model });
    await reload();
  }

  return (
    <div className="max-w-4xl mx-auto p-3 sm:p-6">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-lg sm:text-xl font-semibold text-zinc-100">{project.name}</h2>
        <button
          onClick={removeProject}
          className="text-xs text-zinc-600 hover:text-rose-400 transition-colors"
        >
          Borrar proyecto
        </button>
      </div>
      {project.path && (
        <p className="text-xs text-zinc-500 mb-3 font-mono">{project.path}</p>
      )}

      {/* Worker bar — lanzar/automatizar workers efímeros (claude -p) */}
      <div className="flex flex-wrap items-center gap-3 mb-3 text-xs">
        <button
          onClick={toggleAutoWorker}
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border transition-colors ${
            project.auto_worker
              ? "border-indigo-500/50 bg-indigo-500/15 text-indigo-300"
              : "border-zinc-700 text-zinc-500 hover:text-zinc-300"
          }`}
          title="Con auto worker, la app lanza un worker (claude -p) cuando creás una tarea, respondés una pregunta o pedís algo más sobre una task. No lo prendas si corrés un loop interactivo en una terminal."
        >
          ⚡ auto worker {project.auto_worker ? "ON" : "off"}
        </button>
        <button
          onClick={togglePowered}
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border transition-colors ${
            projectPoweredOff(project)
              ? "border-zinc-700 text-zinc-500 hover:text-zinc-300"
              : "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
          }`}
          title="El proyecto se mantiene prendido (arriba en el sidebar) hasta que lo apagues a mano. Si el loop vuelve a tener actividad, se prende solo de nuevo."
        >
          {projectPoweredOff(project) ? "○ apagado" : "● prendido"}
        </button>
        {project.worker_running ? (
          <span
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
            title={
              project.worker_started_at
                ? `arrancó ${timeAgo(project.worker_started_at, now)}`
                : undefined
            }
          >
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
            </span>
            worker corriendo
            {project.worker_started_at &&
              ` · arrancó ${timeAgo(project.worker_started_at, now)}`}
          </span>
        ) : (
          <button
            onClick={runWorkerNow}
            disabled={!project.path}
            className="px-2.5 py-1 rounded-md bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-medium transition-colors"
            title={
              project.path
                ? "Lanzar un worker ahora: procesa la cola de tareas y termina"
                : "Cargá el path del repo para poder lanzar workers"
            }
          >
            ▶ Correr ahora
          </button>
        )}

        {/* Modelo de Claude Code para los workers de este proyecto */}
        <label className="inline-flex items-center gap-1.5 text-zinc-500">
          modelo
          <select
            value={project.worker_model ?? DEFAULT_WORKER_MODEL}
            onChange={(e) => saveWorkerModel(e.target.value)}
            className="px-2 py-1 rounded-md bg-zinc-800/70 border border-zinc-700 text-zinc-200 outline-none cursor-pointer focus:border-indigo-500"
            title="Modelo que usan los workers (claude -p) de este proyecto"
          >
            {WORKER_MODELS.map((m, i) => (
              <option key={m.alias} value={m.alias}>
                {m.label}
                {i === 0 ? " (último)" : ""}
              </option>
            ))}
          </select>
        </label>

        {/* Ver actividad en vivo del worker (oculto por default) */}
        <button
          onClick={() => setShowActivity((v) => !v)}
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border transition-colors ${
            showActivity
              ? "border-zinc-600 bg-zinc-800 text-zinc-200"
              : "border-zinc-700 text-zinc-500 hover:text-zinc-300"
          }`}
          title="Mostrar/ocultar el print en vivo de lo que hace el worker"
        >
          {showActivity ? "▾" : "▸"} actividad
        </button>
      </div>

      {showActivity && <WorkerActivity projectId={project.id} />}

      {/* Git / push bar */}
      <div className="flex flex-col gap-2 mb-5 text-xs">
       <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span className="text-zinc-500">destino</span>
          <select
            value={project.target_branch}
            onChange={(e) => {
              const dest = project.branches.find((b) => b.branch === e.target.value);
              if (dest) selectDest(dest.branch, dest.stage);
            }}
            className="w-44 px-2 py-1 rounded-md bg-zinc-800/70 border border-zinc-700 text-zinc-100 font-mono outline-none focus:border-indigo-500 cursor-pointer"
            title="Rama a la que el loop pushea — elegí uno de los destinos configurados (✎ para agregar ramas reales del remoto)"
          >
            {!project.branches.some((b) => b.branch === project.target_branch) && (
              <option value={project.target_branch}>
                {project.target_branch} (sin configurar)
              </option>
            )}
            {project.branches.map((b) => (
              <option key={b.id} value={b.branch}>
                {b.branch} → {b.stage}
              </option>
            ))}
          </select>
          <span
            className={`px-2 py-1 rounded-md border font-mono ${STAGE_STYLE[project.push_stage as Stage] ?? STAGE_STYLE.develop}`}
            title="Stage al que pasan las tasks cuando se pushea a esta rama"
          >
            {project.push_stage}
          </span>
          <button
            onClick={toggleEditingDest}
            className="text-zinc-500 hover:text-zinc-300"
            title="Editar destinos del proyecto"
          >
            {editingDest ? "▾" : "✎"}
          </button>
        </div>
        {project.push_requested ? (
          <span className="inline-flex items-center gap-2 px-2.5 py-1 rounded-md border border-amber-500/40 bg-amber-500/15 text-amber-300">
            ⏳ pedido a {project.target_branch} — el loop lo ejecutará
            <button
              onClick={cancelPush}
              className="text-amber-200/70 hover:text-amber-100"
              title="Cancelar pedido"
            >
              ✕
            </button>
          </span>
        ) : (
          <button
            onClick={requestPush}
            className="px-3 py-1 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white font-medium transition-colors"
            title={
              promoteStrategy === "push"
                ? "Pide al loop commitear y pushear al destino"
                : "Pide al loop ejecutar el proceso de promoción configurado para este destino"
            }
          >
            {pushVerb}
            {tasksToCommit > 0 ? ` · ${tasksToCommit} a commitear` : ""}
          </button>
        )}
        <button
          onClick={commitAll}
          disabled={tasksCommittable === 0}
          className="px-3 py-1 rounded-md bg-sky-600 hover:bg-sky-500 disabled:opacity-40 disabled:cursor-default text-white font-medium transition-colors"
          title="Commitea en local todas las tasks hechas, no commiteadas y no archivadas (sin pushear)"
        >
          ⎇ Commit all
          {tasksCommittable > 0 ? ` · ${tasksCommittable}` : ""}
        </button>
        {project.last_push_at &&
          (pushKind === "confirm" ? (
            // El worker no falló: necesita que el humano decida (promoción que
            // requiere merge/PR, rama divergida, etc.). Ámbar, no rojo.
            <span className="inline-flex items-start gap-2 px-2.5 py-1 rounded-md border border-amber-500/40 bg-amber-500/15 text-amber-300 max-w-full">
              <span className="min-w-0">
                <span className="font-medium">⚠ necesita tu decisión:</span>{" "}
                {pushStatusBody}{" "}
                <span className="text-amber-300/60">
                  · {timeAgo(project.last_push_at, now)}
                </span>
              </span>
              <button
                onClick={dismissPushStatus}
                className="text-amber-200/70 hover:text-amber-100 shrink-0"
                title="Descartar"
              >
                ✕
              </button>
            </span>
          ) : pushKind === "error" ? (
            <span className="inline-flex items-start gap-2 text-rose-400 max-w-full">
              <span className="min-w-0">
                último push: error: {pushStatusBody} ·{" "}
                {timeAgo(project.last_push_at, now)}
              </span>
              <button
                onClick={dismissPushStatus}
                className="text-rose-300/70 hover:text-rose-200 shrink-0"
                title="Descartar"
              >
                ✕
              </button>
            </span>
          ) : (
            <span className="inline-flex items-center gap-2 text-zinc-500">
              último push: {project.push_status} ·{" "}
              {timeAgo(project.last_push_at, now)}
              <button
                onClick={dismissPushStatus}
                className="text-zinc-600 hover:text-zinc-400"
                title="Descartar"
              >
                ✕
              </button>
            </span>
          ))}
       </div>

       {/* Editor de destinos (rama → stage) del proyecto */}
       {editingDest && (
        <div className="flex flex-col gap-2 p-3 rounded-md border border-zinc-800 bg-zinc-900/40">
          {/* Estado del remoto: URL + refresh de las ramas reales */}
          <div className="flex items-center gap-2 text-[0.7rem] text-zinc-500">
            <span>remoto:</span>
            {loadingRemote ? (
              <span className="text-zinc-400">leyendo ramas…</span>
            ) : remote?.error ? (
              <span className="text-rose-400" title={remote.error}>
                ⚠ {remote.error}
              </span>
            ) : remote?.remote ? (
              <span className="font-mono text-zinc-400 truncate max-w-[60%]">
                {remote.remote}
                <span className="text-zinc-600"> · {remote.branches.length} ramas</span>
              </span>
            ) : (
              <span className="text-zinc-600">—</span>
            )}
            <button
              onClick={loadRemote}
              disabled={loadingRemote}
              className="text-zinc-500 hover:text-zinc-300 disabled:opacity-40"
              title="Releer las ramas del remoto"
            >
              ⟳
            </button>
          </div>

          <div className="flex flex-col gap-2">
            {project.branches.map((b) => (
              <div
                key={b.id}
                className="flex flex-col gap-1.5 p-2 rounded border border-zinc-800/80 bg-zinc-900/30"
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-zinc-300">{b.branch}</span>
                  <span className="text-zinc-600">→</span>
                  <select
                    value={b.stage}
                    onChange={(e) =>
                      addDest(b.branch, e.target.value as "develop" | "production")
                    }
                    className={`px-1.5 py-0.5 rounded border outline-none cursor-pointer text-xs ${STAGE_STYLE[b.stage as Stage] ?? STAGE_STYLE.develop}`}
                    title="Stage de este destino"
                  >
                    <option value="develop">develop</option>
                    <option value="production">production</option>
                  </select>
                  {!remote?.error &&
                    remote &&
                    !remote.branches.includes(b.branch) && (
                      <span
                        className="text-amber-400 text-[0.7rem]"
                        title="Esta rama no existe en el remoto"
                      >
                        ⚠ no está en el remoto
                      </span>
                    )}
                  {project.branches.length > 1 && (
                    <button
                      onClick={() => removeDest(b.id)}
                      className="ml-auto text-zinc-600 hover:text-rose-400"
                      title="Borrar destino"
                    >
                      ✕
                    </button>
                  )}
                </div>
                <BranchPromotionEditor
                  branch={b}
                  remoteBranches={remote?.branches ?? null}
                  onSave={(fields) => savePromotion(b.id, fields)}
                />
              </div>
            ))}
          </div>

          {/* Agregar destino: se elige una rama REAL del remoto, sin tipear */}
          <div className="flex items-center gap-2 pt-1 border-t border-zinc-800">
            {(() => {
              const taken = new Set(project.branches.map((b) => b.branch));
              const available = (remote?.branches ?? []).filter(
                (b) => !taken.has(b)
              );
              if (loadingRemote) {
                return <span className="text-zinc-500">leyendo ramas del remoto…</span>;
              }
              if (!remote || remote.error) {
                return (
                  <span className="text-zinc-500">
                    no hay ramas del remoto para elegir
                    {remote?.error ? "" : " (probá ⟳)"}
                  </span>
                );
              }
              if (available.length === 0) {
                return (
                  <span className="text-zinc-500">
                    todas las ramas del remoto ya son destinos
                  </span>
                );
              }
              return (
                <>
                  <select
                    value={newBranch}
                    onChange={(e) => setNewBranch(e.target.value)}
                    className="w-40 px-2 py-1 rounded-md bg-zinc-800/70 border border-zinc-700 text-zinc-100 font-mono outline-none focus:border-indigo-500 cursor-pointer"
                  >
                    {available.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                  <span className="text-zinc-600">→</span>
                  <select
                    value={newStage}
                    onChange={(e) =>
                      setNewStage(e.target.value as "develop" | "production")
                    }
                    className={`px-2 py-1 rounded-md border outline-none cursor-pointer ${STAGE_STYLE[newStage]}`}
                  >
                    <option value="develop">develop</option>
                    <option value="production">production</option>
                  </select>
                  <button
                    onClick={() => addDest()}
                    className="px-2 py-1 rounded-md bg-zinc-700 hover:bg-zinc-600 text-zinc-100"
                  >
                    + agregar
                  </button>
                </>
              );
            })()}
          </div>
        </div>
       )}
      </div>

      {/* Document tabs */}
      <div className="flex items-center gap-1 border-b border-zinc-800 mb-5 flex-wrap">
        {project.documents.map((d) => {
          const open = d.tasks.reduce(
            (n, t) => n + t.questions.filter((q) => !q.answered).length,
            0
          );
          const unseenDoc = d.tasks.some(isTaskUnseen);
          const active = doc?.id === d.id;
          return (
            <button
              key={d.id}
              onClick={() => onSelectDoc(d.id)}
              className={`px-3 py-2 -mb-px border-b-2 flex items-center gap-1.5 transition-colors ${
                active
                  ? "border-indigo-500 text-zinc-100 font-medium"
                  : "border-transparent text-zinc-500 hover:text-zinc-200"
              }`}
            >
              {d.name}
              {open > 0 && (
                <span className="min-w-4 h-4 px-1 rounded-full bg-rose-500 text-white text-[0.625rem] flex items-center justify-center">
                  {open}
                </span>
              )}
              {unseenDoc && (
                <span className="text-sky-400 text-[0.625rem]" title="Tiene novedades del loop sin ver">
                  ✦
                </span>
              )}
            </button>
          );
        })}
        {addingDoc ? (
          <span className="flex items-center gap-1 px-2">
            <input
              autoFocus
              value={docName}
              onChange={(e) => setDocName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createDoc()}
              placeholder="Documento"
              className="px-2 py-1 rounded-md bg-zinc-800/70 border border-zinc-700 text-zinc-100 text-sm w-28 outline-none focus:border-indigo-500"
            />
            <button onClick={createDoc} className="text-indigo-400 hover:text-indigo-300">
              ✓
            </button>
            <button onClick={() => setAddingDoc(false)} className="text-zinc-500">
              ✕
            </button>
          </span>
        ) : (
          <button
            onClick={() => setAddingDoc(true)}
            className="px-2 py-2 text-zinc-600 hover:text-indigo-400 transition-colors"
            title="Nuevo documento"
          >
            +
          </button>
        )}
      </div>

      {doc ? (
        <DocPanel
          doc={doc}
          workerRunning={project.worker_running}
          reload={reload}
          isTaskUnseen={isTaskUnseen}
          markTaskSeen={markTaskSeen}
        />
      ) : (
        <p>Sin documentos.</p>
      )}
      {dialog}
    </div>
  );
}

function DocPanel({
  doc,
  workerRunning,
  reload,
  isTaskUnseen,
  markTaskSeen,
}: {
  doc: DocumentView;
  workerRunning: boolean;
  reload: () => Promise<unknown>;
  isTaskUnseen: (t: TaskView) => boolean;
  markTaskSeen: (taskId: number) => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  function addFiles(list: FileList | null | undefined) {
    const imgs = imagesFromTransfer(list);
    if (imgs.length === 0) return;
    setImages((prev) => [
      ...prev,
      ...imgs.map((i) => ({ key: crypto.randomUUID(), ...i })),
    ]);
  }

  function removeImage(key: string) {
    setImages((prev) => {
      const hit = prev.find((p) => p.key === key);
      if (hit) URL.revokeObjectURL(hit.url);
      return prev.filter((p) => p.key !== key);
    });
  }

  async function createTask() {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      const { id } = await api("/api/tasks", "POST", {
        document_id: doc.id,
        title,
        body,
      });
      for (const img of images) await uploadAttachment(id, img.file);
      images.forEach((i) => URL.revokeObjectURL(i.url));
      setImages([]);
      setTitle("");
      setBody("");
      await reload();
    } finally {
      setBusy(false);
    }
  }

  // Lo que se oculta es lo ARCHIVADO (acción explícita del humano), no el
  // stage: una task puede estar en producción y seguir visible. El stage es
  // solo un metadato de dónde vive el código.
  const archived = doc.tasks.filter((t) => t.archived);
  const visible = doc.tasks
    .filter((t) => !t.archived)
    // pending tasks first, done below
    .sort((a, b) => Number(a.status === "done") - Number(b.status === "done"));

  return (
    <div className="space-y-4">
      {/* New task */}
      <div
        onPaste={(e) => {
          if (e.clipboardData.files.length) {
            e.preventDefault();
            addFiles(e.clipboardData.files);
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          addFiles(e.dataTransfer.files);
        }}
        className={`rounded-xl border bg-zinc-900 p-3 space-y-2 transition-colors ${
          dragOver ? "border-indigo-500 ring-1 ring-indigo-500/40" : "border-zinc-800"
        }`}
      >
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && createTask()}
          placeholder="Nueva tarea…"
          className={INPUT}
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              createTask();
            }
          }}
          placeholder="Detalle / contexto (opcional). Enter = nueva línea · Ctrl/⌘+Enter = crear. Pegá o arrastrá imágenes acá."
          rows={2}
          className={`${INPUT} resize-y`}
        />

        {images.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {images.map((img) => (
              <div key={img.key} className="relative group">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.url}
                  alt={img.file.name}
                  className="h-16 w-16 object-cover rounded-md border border-zinc-700"
                />
                <button
                  onClick={() => removeImage(img.key)}
                  className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-zinc-800 border border-zinc-600 text-zinc-300 text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Quitar"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-between items-center">
          <button
            onClick={() => fileInput.current?.click()}
            className="text-xs text-zinc-400 hover:text-indigo-400 transition-colors flex items-center gap-1"
          >
            📎 Adjuntar imagen
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            onClick={createTask}
            disabled={busy}
            className="px-3.5 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium transition-colors"
          >
            {busy ? "Creando…" : "Crear tarea"}
          </button>
        </div>
      </div>

      {visible.map((t) => (
        <TaskRow
          key={t.id}
          task={t}
          workerRunning={workerRunning}
          reload={reload}
          unseen={isTaskUnseen(t)}
          onSeen={() => markTaskSeen(t.id)}
        />
      ))}

      {archived.length > 0 && (
        <details className="pt-1">
          <summary className="cursor-pointer text-zinc-500 hover:text-zinc-300 text-xs uppercase tracking-wide select-none">
            Archivadas ({archived.length})
          </summary>
          <div className="space-y-3 mt-3">
            {archived.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                workerRunning={workerRunning}
                reload={reload}
                unseen={isTaskUnseen(t)}
                onSeen={() => markTaskSeen(t.id)}
              />
            ))}
          </div>
        </details>
      )}

      {doc.tasks.length === 0 && (
        <p className="text-zinc-600 text-center py-10">Todavía no hay tareas.</p>
      )}
    </div>
  );
}

function TaskRow({
  task,
  workerRunning,
  reload,
  unseen,
  onSeen,
}: {
  task: TaskView;
  workerRunning: boolean;
  reload: () => Promise<unknown>;
  unseen: boolean;
  onSeen: () => void;
}) {
  const isDone = task.status === "done";
  const openQuestions = task.questions.filter((q) => !q.answered);
  // Cada pregunta vive dentro del turno en que Claude la hizo, para que colapse
  // junto con ese turno (pedido original o follow-up) en vez de quedar suelta.
  const questionsByTurn = bucketQuestions(task);
  // Las tasks con novedad del loop sin ver arrancan expandidas al abrir el
  // proyecto; el resto, colapsadas.
  const [expanded, setExpanded] = useState(unseen);
  // Una task que se resuelve mientras la tenés a la vista (ya estaba montada
  // como in_progress y la habías visto, así que `expanded` quedó en false) no
  // se re-expandía al pasar a done, porque `expanded` se fija solo al montar.
  // Detectamos la transición a done y, si todavía no la leíste, la abrimos.
  // Solo en la transición: el churn posterior (commit, stage, archivado) deja
  // el status en done, así que no la reabre.
  const prevStatus = useRef(task.status);
  useEffect(() => {
    if (prevStatus.current !== "done" && task.status === "done" && unseen) {
      setExpanded(true);
    }
    prevStatus.current = task.status;
  }, [task.status, unseen]);
  useEffect(() => {
    // Mientras la task esté a la vista en el proyecto abierto, dala por vista.
    // No alcanza con marcarla al montar: si el loop la vuelve a tocar (commit,
    // cambio de stage, archivado…) su `updated_at` se mueve y volvería a contar
    // como "novedad sin ver" aunque la tengas enfrente. Re-marcar cada vez que
    // `unseen` se reactiva la mantiene vista —mismo criterio que el proyecto
    // abierto, que se marca visto en cada poll. (`expanded` se fija solo al
    // montar, así que el churn no la re-expande: solo apaga el ✦.)
    if (unseen) onSeen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unseen]);
  // Abrir manualmente una task también la marca como vista (apaga el ✦).
  function toggle() {
    if (!expanded) onSeen();
    setExpanded((v) => !v);
  }
  const [dragOver, setDragOver] = useState(false);
  const [editing, setEditing] = useState(false);
  const [eTitle, setETitle] = useState(task.title);
  const [eBody, setEBody] = useState(task.body);
  const [eSummary, setESummary] = useState(task.summary ?? "");
  const fileInput = useRef<HTMLInputElement>(null);

  const now = Date.now();
  const working =
    task.status === "in_progress" &&
    !!task.last_heartbeat &&
    now - parseUTC(task.last_heartbeat) < WORKING_FRESH_MS;
  // Sin heartbeat fresco pero con el worker del proyecto vivo: típico de un
  // comando largo (tests, build). Solo es "sin señal" si tampoco hay worker.
  const workerBusy = task.status === "in_progress" && !working && workerRunning;
  const stalled = task.status === "in_progress" && !working && !workerRunning;

  async function patch(p: Record<string, unknown>) {
    await api(`/api/tasks/${task.id}`, "PATCH", p);
    await reload();
  }
  function startEdit() {
    setETitle(task.title);
    setEBody(task.body);
    setESummary(task.summary ?? "");
    setEditing(true);
  }
  async function saveEdit() {
    if (!eTitle.trim()) return;
    await patch({ title: eTitle.trim(), body: eBody, summary: eSummary });
    setEditing(false);
  }
  async function remove() {
    await api(`/api/tasks/${task.id}`, "DELETE");
    await reload();
  }
  async function attach(list: FileList | null | undefined) {
    const imgs = Array.from(list ?? []).filter((f) => f.type.startsWith("image/"));
    if (imgs.length === 0) return;
    for (const f of imgs) await uploadAttachment(task.id, f);
    await reload();
  }
  async function requestCommit() {
    await api(`/api/tasks/${task.id}/commit-request`, "POST", {});
    await reload();
  }
  async function cancelCommit() {
    await api(`/api/tasks/${task.id}/commit-request`, "POST", { requested: false });
    await reload();
  }

  const committed = !!task.commit_hash;
  const commitPending = task.commit_requested;

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        attach(e.dataTransfer.files);
      }}
      onPaste={(e) => {
        // Pegar imágenes (p. ej. mientras editás) las adjunta al instante. El
        // texto normal sigue su curso: solo interceptamos si hay archivos imagen.
        const hasImage = Array.from(e.clipboardData.files).some((f) =>
          f.type.startsWith("image/")
        );
        if (!hasImage) return;
        e.preventDefault();
        attach(e.clipboardData.files);
      }}
      className={`rounded-xl border p-3.5 transition-colors ${
        dragOver
          ? "border-indigo-500 ring-1 ring-indigo-500/40"
          : openQuestions.length > 0
            ? "border-rose-500/40 ring-1 ring-rose-500/20 bg-rose-950/20"
            : "border-zinc-800 bg-zinc-900"
      }`}
    >
      {/* Header — siempre visible; togglea el detalle. En pantallas angostas
          los badges bajan a una segunda línea (flex-wrap). */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={toggle}
          className={`shrink-0 flex items-center justify-center h-6 w-6 rounded-md border transition-colors ${
            expanded
              ? "border-indigo-500/40 bg-indigo-500/15 text-indigo-300 hover:bg-indigo-500/25"
              : "border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 hover:border-zinc-600"
          }`}
          title={expanded ? "Colapsar" : "Expandir"}
          aria-expanded={expanded}
        >
          <svg
            className={`h-3.5 w-3.5 transition-transform duration-200 ${expanded ? "rotate-90" : ""}`}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M6 4l4 4-4 4" />
          </svg>
        </button>
        {unseen && (
          <span
            className="shrink-0 text-sky-400 text-sm leading-none"
            title="Novedad del loop sin ver — abrila para marcarla vista"
          >
            ✦
          </span>
        )}
        <span
          onClick={toggle}
          className="flex-1 min-w-0 font-medium truncate cursor-pointer text-zinc-100"
        >
          {task.title}
        </span>
        <div className="flex flex-wrap items-center justify-end gap-2 ml-auto">
          {task.created_by === "loop" && (
            <span className="hidden sm:inline text-[0.625rem] px-1.5 py-0.5 rounded border border-indigo-500/30 bg-indigo-500/15 text-indigo-300">
              loop
            </span>
          )}
          {working ? (
            <span
              className="inline-flex items-center gap-1.5 text-[0.6875rem] px-2 py-0.5 rounded-full border border-emerald-500/40 bg-emerald-500/15 text-emerald-300 shrink-0"
              title={`última señal ${timeAgo(task.last_heartbeat!, now)}${task.heartbeat_note ? ` · ${task.heartbeat_note}` : ""}`}
            >
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
              </span>
              trabajando
            </span>
          ) : workerBusy ? (
            <span
              className="inline-flex items-center gap-1.5 text-[0.6875rem] px-2 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-300/90 shrink-0"
              title={
                "El worker está corriendo pero sin señal reciente — típico de un comando largo (tests, build)." +
                (task.last_heartbeat
                  ? ` Última señal ${timeAgo(task.last_heartbeat, now)}.`
                  : "") +
                (task.heartbeat_note ? ` · ${task.heartbeat_note}` : "")
              }
            >
              <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400/70" />
              worker activo
              {task.last_heartbeat &&
                ` · señal ${timeAgo(task.last_heartbeat, now)}`}
            </span>
          ) : stalled ? (
            <span
              className="text-[0.6875rem] px-2 py-0.5 rounded-full border border-amber-500/40 bg-amber-500/15 text-amber-300"
              title="Nadie está trabajando esta task ahora (el loop/worker se cortó o terminó sin cerrarla). Relanzá con ▶ Correr ahora."
            >
              sin señal
            </span>
          ) : (
            <StatusBadge status={task.status} />
          )}
          {(task.status === "done" || task.stage !== "local") && (
            <span
              className={`hidden sm:inline-flex items-center gap-1 text-[0.625rem] px-1.5 py-0.5 rounded-full border ${STAGE_STYLE[task.stage]}`}
              title="Dónde vive esta feature / resolución"
            >
              📍 {task.stage}
            </span>
          )}
          {openQuestions.length > 0 && (
            <span
              className="inline-flex items-center gap-1 text-[0.6875rem] px-2 py-0.5 rounded-full border border-rose-500/50 bg-rose-500/20 text-rose-200"
              title="Preguntas sin responder"
            >
              ❓ {openQuestions.length}
            </span>
          )}
          {/* Acciones en el header — solo desktop; en mobile viven en el
              detalle expandido para no tapar el título. */}
          {committed ? (
            <span
              className="hidden sm:inline text-[0.6875rem] px-1.5 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/15 text-emerald-300 font-mono"
              title={`commiteado ${task.committed_at ? timeAgo(task.committed_at, now) : ""}`}
            >
              ✓ {task.commit_hash!.slice(0, 7)}
            </span>
          ) : commitPending ? (
            <span
              className="hidden sm:inline-flex items-center gap-1 text-[0.6875rem] px-2 py-0.5 rounded-full border border-amber-500/40 bg-amber-500/15 text-amber-300"
              title="Pedido de commit. El loop lo hará en su próxima iteración."
            >
              ⏳ commit
              <button onClick={cancelCommit} className="text-amber-200/70 hover:text-amber-100" title="Cancelar">
                ✕
              </button>
            </span>
          ) : (
            <button
              onClick={requestCommit}
              className="hidden sm:inline text-[0.6875rem] px-2 py-0.5 rounded-full border border-zinc-700 text-zinc-400 hover:text-emerald-300 hover:border-emerald-500/40 transition-colors"
              title="Pedir que el loop commitee esta task"
            >
              commit
            </button>
          )}
          {task.tested && (
            <span
              className="hidden sm:inline text-[0.6875rem] px-1.5 py-0.5 rounded-full border border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
              title="Probaste esta feature"
            >
              ✓ probada
            </span>
          )}
          {task.archived ? (
            <button
              onClick={() => patch({ archived: false })}
              className="hidden sm:inline text-[0.6875rem] px-2 py-0.5 rounded-full border border-zinc-700 text-zinc-400 hover:text-indigo-300 hover:border-indigo-500/40 transition-colors"
              title="Desarchivar: la devuelve a la vista principal"
            >
              ↩ desarchivar
            </button>
          ) : (
            <button
              onClick={() => patch({ archived: true, status: "done" })}
              className="hidden sm:inline text-[0.6875rem] px-2 py-0.5 rounded-full border border-zinc-700 text-zinc-400 hover:text-emerald-300 hover:border-emerald-500/40 transition-colors"
              title="Archivar: la da por hecha y la oculta en 'Archivadas' (no cambia el stage)"
            >
              📦 archivar
            </button>
          )}
        </div>
      </div>

      {/* Detalle — solo cuando está expandida */}
      {expanded && (
        <div className="mt-3 pl-1.5 sm:pl-6 space-y-3">
          {/* Nota del proceso en curso — el detalle de "en qué se está
              trabajando" vive acá, con espacio y sin recortar. La pill del
              header solo deja la señal de "trabajando" visible al colapsar. */}
          {(working || workerBusy) && task.heartbeat_note && (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2">
              <div className="flex items-center gap-1.5 text-[0.625rem] uppercase tracking-wide text-emerald-400/80 mb-1">
                {working ? (
                  <span className="relative flex h-2 w-2 shrink-0">
                    <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
                  </span>
                ) : (
                  <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400/70" />
                )}
                {working ? "trabajando" : "worker activo"}
              </div>
              <p className="text-sm text-emerald-100 whitespace-pre-wrap break-words">
                {task.heartbeat_note}
              </p>
            </div>
          )}
          {editing ? (
            <>
            <div className="space-y-2">
              <input
                autoFocus
                value={eTitle}
                onChange={(e) => setETitle(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && saveEdit()}
                className={INPUT}
              />
              <textarea
                value={eBody}
                onChange={(e) => setEBody(e.target.value)}
                rows={3}
                placeholder="Detalle / contexto. Pegá o arrastrá imágenes para adjuntarlas."
                className={`${INPUT} resize-y`}
              />
              <label className="block text-[0.6875rem] uppercase tracking-wide text-zinc-500">
                Resumen
              </label>
              <textarea
                value={eSummary}
                onChange={(e) => setESummary(e.target.value)}
                rows={4}
                placeholder="Qué se hizo. Si era un bug: dónde estaba, la causa, y cómo se resolvió."
                className={`${INPUT} resize-y font-mono text-xs`}
              />
              <div className="flex gap-2">
                <button
                  onClick={saveEdit}
                  className="px-3 py-1 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium"
                >
                  Guardar
                </button>
                <button
                  onClick={() => setEditing(false)}
                  className="px-3 py-1 rounded-md border border-zinc-700 text-zinc-400 text-xs"
                >
                  Cancelar
                </button>
              </div>
            </div>
            {task.attachments.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {task.attachments.map((a) => (
                  <AttachmentThumb key={a.id} a={a} reload={reload} />
                ))}
              </div>
            )}
            {task.followups.length > 0 && (
              <div className="space-y-2">
                {task.followups.map((f) => (
                  <FollowupBlock
                    key={f.id}
                    f={f}
                    questions={questionsByTurn.byFollowup.get(f.id) ?? []}
                    reload={reload}
                  />
                ))}
              </div>
            )}
            </>
          ) : (
            <>
              {/* Hilo invertido: el input para escribir va arriba de todo y el
                  turno más nuevo queda siempre a la vista; el pedido original
                  baja al fondo. Mientras haya una pregunta del sistema sin
                  responder, ocultamos este campo: confunde con el input de
                  respuesta (que vive dentro de la pregunta) y el humano termina
                  escribiendo acá sin disparar la respuesta. */}
              {openQuestions.length === 0 && (
                <FollowupInput taskId={task.id} done={isDone} reload={reload} />
              )}

              {/* Pedidos posteriores del humano, del más nuevo al más viejo.
                  Cada follow-up arrastra sus propias preguntas adentro. */}
              {task.followups.length > 0 && (
                <div className="space-y-2">
                  {[...task.followups].reverse().map((f) => (
                    <FollowupBlock
                      key={f.id}
                      f={f}
                      questions={questionsByTurn.byFollowup.get(f.id) ?? []}
                      reload={reload}
                    />
                  ))}
                </div>
              )}

              {task.attachments.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {task.attachments.map((a) => (
                    <AttachmentThumb key={a.id} a={a} reload={reload} />
                  ))}
                </div>
              )}

              <OriginalTurn
                task={task}
                isDone={isDone}
                collapsible={task.followups.length > 0}
                questions={questionsByTurn.original}
                reload={reload}
              />
            </>
          )}

          {/* Controles */}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <label className="flex items-center gap-1.5 text-sm text-zinc-400 cursor-pointer">
              <input
                type="checkbox"
                checked={isDone}
                onChange={(e) => patch({ status: e.target.checked ? "done" : "todo" })}
                className="h-4 w-4 accent-indigo-500"
              />
              hecha
            </label>

            <label className="flex items-center gap-1.5 text-sm text-zinc-400 cursor-pointer">
              <input
                type="checkbox"
                checked={task.tested}
                onChange={(e) => patch({ tested: e.target.checked })}
                className="h-4 w-4 accent-emerald-500"
              />
              probada
            </label>

            {/* commit / archivar: solo mobile — en desktop están en
                el header de la fila (colapsada y expandida). */}
            {committed ? (
              <span
                className="sm:hidden text-[0.6875rem] px-2 py-1 rounded-full border border-emerald-500/30 bg-emerald-500/15 text-emerald-300 font-mono"
                title={`commiteado ${task.committed_at ? timeAgo(task.committed_at, now) : ""}`}
              >
                ✓ {task.commit_hash!.slice(0, 7)}
              </span>
            ) : commitPending ? (
              <span
                className="sm:hidden inline-flex items-center gap-1 text-[0.6875rem] px-2 py-1 rounded-full border border-amber-500/40 bg-amber-500/15 text-amber-300"
                title="Pedido de commit. El loop lo hará en su próxima iteración."
              >
                ⏳ commit
                <button
                  onClick={cancelCommit}
                  className="text-amber-200/70 hover:text-amber-100"
                  title="Cancelar"
                >
                  ✕
                </button>
              </span>
            ) : (
              <button
                onClick={requestCommit}
                className="sm:hidden text-[0.6875rem] px-2 py-1 rounded-full border border-zinc-700 text-zinc-400 hover:text-emerald-300 hover:border-emerald-500/40 transition-colors"
                title="Pedir que el loop commitee esta task"
              >
                commit
              </button>
            )}
            {task.archived ? (
              <button
                onClick={() => patch({ archived: false })}
                className="sm:hidden text-[0.6875rem] px-2 py-1 rounded-full border border-zinc-700 text-zinc-400 hover:text-indigo-300 hover:border-indigo-500/40 transition-colors"
                title="Desarchivar: la devuelve a la vista principal"
              >
                ↩ desarchivar
              </button>
            ) : (
              <button
                onClick={() => patch({ archived: true, status: "done" })}
                className="sm:hidden text-[0.6875rem] px-2 py-1 rounded-full border border-zinc-700 text-zinc-400 hover:text-emerald-300 hover:border-emerald-500/40 transition-colors"
                title="Archivar: la da por hecha y la oculta en 'Archivadas' (no cambia el stage)"
              >
                📦 archivar
              </button>
            )}

            <div className="ml-auto flex items-center gap-1">
              <button
                onClick={startEdit}
                className="p-2 rounded-md text-base leading-none text-zinc-500 hover:bg-zinc-800 hover:text-indigo-300 transition-colors"
                title="Editar"
              >
                ✎
              </button>
              <button
                onClick={() => fileInput.current?.click()}
                className="p-2 rounded-md text-base leading-none text-zinc-500 hover:bg-zinc-800 hover:text-indigo-300 transition-colors"
                title="Adjuntar imagen"
              >
                📎
              </button>
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  attach(e.target.files);
                  e.target.value = "";
                }}
              />
              <button
                onClick={remove}
                className="p-2 rounded-md text-base leading-none text-zinc-500 hover:bg-zinc-800 hover:text-rose-400 transition-colors"
                title="Borrar"
              >
                ✕
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AttachmentThumb({
  a,
  reload,
}: {
  a: TaskView["attachments"][number];
  reload: () => Promise<unknown>;
}) {
  const src = `/api/attachments/${a.id}`;
  const isImage = a.mime.startsWith("image/");

  async function del() {
    await api(`/api/attachments/${a.id}`, "DELETE");
    await reload();
  }

  return (
    <div className="relative group">
      <a href={src} target="_blank" rel="noreferrer" title={a.filename}>
        {isImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={a.filename}
            className="h-20 w-20 object-cover rounded-md border border-zinc-700 hover:border-indigo-500 transition-colors"
          />
        ) : (
          <span className="h-20 w-20 rounded-md border border-zinc-700 flex items-center justify-center text-zinc-400 text-xs px-1 text-center">
            {a.filename}
          </span>
        )}
      </a>
      <button
        onClick={del}
        className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-zinc-800 border border-zinc-600 text-zinc-300 text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
        title="Borrar adjunto"
      >
        ✕
      </button>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    todo: "bg-zinc-800 text-zinc-400 border-zinc-700",
    in_progress: "bg-blue-500/15 text-blue-300 border-blue-500/30",
    blocked: "bg-rose-500/15 text-rose-300 border-rose-500/30",
    done: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  };
  // Etiqueta en español para mostrar (el valor crudo del status no cambia).
  const label: Record<string, string> = {
    todo: "pendiente",
    in_progress: "en progreso",
    blocked: "bloqueada",
    done: "HECHA",
  };
  return (
    <span
      className={`text-[0.625rem] px-1.5 py-0.5 rounded border ${map[status] ?? map.todo}`}
    >
      {label[status] ?? status.replace("_", " ")}
    </span>
  );
}

function QuestionBlock({
  q,
  reload,
}: {
  q: TaskView["questions"][number];
  reload: () => Promise<unknown>;
}) {
  const [answer, setAnswer] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  function addFiles(list: FileList | null | undefined) {
    const imgs = imagesFromTransfer(list);
    if (imgs.length === 0) return;
    setImages((prev) => [
      ...prev,
      ...imgs.map((i) => ({ key: crypto.randomUUID(), ...i })),
    ]);
  }
  function removeImage(key: string) {
    setImages((prev) => {
      const hit = prev.find((p) => p.key === key);
      if (hit) URL.revokeObjectURL(hit.url);
      return prev.filter((p) => p.key !== key);
    });
  }

  async function send() {
    if ((!answer.trim() && images.length === 0) || busy) return;
    setBusy(true);
    try {
      // Las imágenes van primero, asociadas a esta pregunta: el worker las ve
      // como adjuntos de la respuesta al leer la task.
      for (const img of images) await uploadAttachment(q.task_id, img.file, q.id);
      images.forEach((i) => URL.revokeObjectURL(i.url));
      setImages([]);
      // La API exige texto; si solo hay imágenes, dejamos una nota.
      await api(`/api/questions/${q.id}/answer`, "POST", {
        answer: answer.trim() || "(ver imágenes adjuntas)",
      });
      setAnswer("");
      await reload();
    } finally {
      setBusy(false);
    }
  }

  if (q.answered) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-800/40 p-3">
        <div className="text-[0.625rem] uppercase tracking-wide text-zinc-500 mb-1">
          ❓ Pregunta
        </div>
        <div className="md">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{q.text}</ReactMarkdown>
        </div>
        <div className="mt-2 pt-2 border-t border-zinc-800/80">
          <div className="text-[0.625rem] uppercase tracking-wide text-emerald-500/70 mb-1">
            ↳ Tu respuesta
          </div>
          <p className="text-emerald-300 whitespace-pre-wrap text-[0.8125rem] leading-relaxed">
            {q.answer}
          </p>
          {q.attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {q.attachments.map((a) => (
                <AttachmentThumb key={a.id} a={a} reload={reload} />
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`rounded-lg border bg-rose-500/10 p-3 ${
        dragOver ? "border-indigo-500" : "border-rose-500/40"
      }`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        addFiles(e.dataTransfer.files);
      }}
    >
      <div className="text-[0.625rem] uppercase tracking-wide text-rose-300/80 mb-1">
        ❓ Claude pregunta
      </div>
      <div className="md">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{q.text}</ReactMarkdown>
      </div>
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-3">
          {images.map((img) => (
            <div key={img.key} className="relative group">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img.url}
                alt=""
                className="h-16 w-16 object-cover rounded-md border border-zinc-700"
              />
              <button
                onClick={() => removeImage(img.key)}
                className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-zinc-800 border border-zinc-600 text-zinc-300 text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                title="Quitar"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2 mt-3">
        <textarea
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          onPaste={(e) => {
            if (e.clipboardData.files.length) {
              e.preventDefault();
              addFiles(e.clipboardData.files);
            }
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          placeholder="Tu respuesta… (Enter = nueva línea · Ctrl/⌘+Enter = enviar · pegá o arrastrá imágenes)"
          className="flex-1 px-2.5 py-1.5 rounded-md bg-zinc-900 border border-rose-500/40 text-zinc-100 placeholder-zinc-500 outline-none focus:border-rose-400 resize-y"
        />
        <div className="flex flex-col gap-1.5 self-start">
          <button
            onClick={send}
            disabled={busy}
            className="px-3 py-1.5 rounded-md bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white text-xs font-medium transition-colors"
          >
            {busy ? "Enviando…" : "Responder"}
          </button>
          <button
            onClick={() => fileInput.current?.click()}
            className="px-3 py-1 rounded-md border border-zinc-700 text-zinc-400 hover:text-indigo-400 hover:border-indigo-500 text-xs transition-colors"
            title="Adjuntar imagen a la respuesta"
          >
            📎
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      </div>
    </div>
  );
}

// Reparte las preguntas de la task entre sus turnos. Cada follow-up abre un
// turno nuevo, así que una pregunta pertenece al follow-up más reciente creado
// antes que ella; si es anterior a todos, va al turno original (el pedido
// inicial). Sin FK que las relacione, nos guiamos por las fechas de creación.
function bucketQuestions(task: TaskView): {
  original: TaskView["questions"];
  byFollowup: Map<number, TaskView["questions"]>;
} {
  const original: TaskView["questions"] = [];
  const byFollowup = new Map<number, TaskView["questions"]>();
  const fups = [...task.followups].sort(
    (a, b) => parseUTC(b.created_at) - parseUTC(a.created_at)
  );
  for (const q of task.questions) {
    const qt = parseUTC(q.created_at);
    const owner = fups.find((f) => parseUTC(f.created_at) <= qt);
    if (owner) {
      const arr = byFollowup.get(owner.id) ?? [];
      arr.push(q);
      byFollowup.set(owner.id, arr);
    } else {
      original.push(q);
    }
  }
  return { original, byFollowup };
}

// Un "turno" de la conversación: cabecera clicable que colapsa/expande su
// contenido. Colapsado, muestra solo el label + un preview en una línea, así un
// hilo largo de varios turnos se puede achicar sin colapsar la task entera.
function CollapsibleTurn({
  label,
  preview,
  containerClass = "",
  defaultCollapsed = false,
  children,
}: {
  label: ReactNode;
  preview: string;
  containerClass?: string;
  defaultCollapsed?: boolean;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  return (
    <div className={containerClass}>
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className={`flex items-center gap-2 w-full text-left select-none group rounded-md -mx-1.5 px-1.5 py-1 transition-colors hover:bg-zinc-700/40 ${
          collapsed ? "" : "mb-1 border-b border-zinc-700/50 rounded-b-none"
        }`}
        title={collapsed ? "Expandir turno" : "Colapsar turno"}
        aria-expanded={!collapsed}
      >
        {/* Chevron recuadrado: deja claro que la cabecera del turno es clicable. */}
        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-zinc-600/80 bg-zinc-800 text-[0.625rem] leading-none text-zinc-400 transition-colors group-hover:border-indigo-400/60 group-hover:bg-indigo-500/15 group-hover:text-indigo-200">
          {collapsed ? "▸" : "▾"}
        </span>
        {label}
        {collapsed ? (
          <span className="text-zinc-500 text-xs truncate min-w-0 flex-1 normal-case font-normal tracking-normal">
            {preview}
          </span>
        ) : (
          <span className="ml-auto shrink-0 text-[0.625rem] uppercase tracking-wide text-zinc-600 opacity-0 transition-opacity group-hover:opacity-100">
            colapsar
          </span>
        )}
      </button>
      {!collapsed && <div className="mt-1.5">{children}</div>}
    </div>
  );
}

// Primer turno del hilo: el pedido original + el resumen de lo que hizo Claude.
// Solo se vuelve colapsable cuando hay follow-ups (es decir, hay más turnos);
// en una task de un solo turno no tiene sentido el doble colapso.
function OriginalTurn({
  task,
  isDone,
  collapsible,
  questions,
  reload,
}: {
  task: TaskView;
  isDone: boolean;
  collapsible: boolean;
  questions: TaskView["questions"];
  reload: () => Promise<unknown>;
}) {
  const content = (
    <>
      {task.body && (
        <p className="text-zinc-400 whitespace-pre-wrap leading-relaxed">
          {task.body}
        </p>
      )}
      {task.summary ? (
        <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/[0.06] p-2.5">
          <div className="text-[0.625rem] uppercase tracking-wide text-emerald-400/80 mb-1">
            📝 Resumen
          </div>
          <div className="md">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{task.summary}</ReactMarkdown>
          </div>
        </div>
      ) : (
        isDone && (
          <p className="text-[0.6875rem] text-amber-400/70">
            ⚠ Tarea hecha sin resumen.
          </p>
        )
      )}
      {questions.length > 0 && (
        <div className="space-y-2">
          {[...questions].reverse().map((q) => (
            <QuestionBlock key={q.id} q={q} reload={reload} />
          ))}
        </div>
      )}
    </>
  );
  if (!collapsible) return content;
  return (
    <CollapsibleTurn
      label={
        <span className="text-[0.625rem] uppercase tracking-wide text-zinc-400/80 shrink-0">
          📋 Pedido original
        </span>
      }
      preview={task.body || task.title}
    >
      <div className="space-y-3">{content}</div>
    </CollapsibleTurn>
  );
}

function FollowupBlock({
  f,
  questions,
  reload,
}: {
  f: TaskView["followups"][number];
  questions: TaskView["questions"];
  reload: () => Promise<unknown>;
}) {
  return (
    <CollapsibleTurn
      containerClass={`rounded-lg border p-3 ${
        f.resolved_at
          ? "border-zinc-800 bg-zinc-800/40"
          : "border-indigo-500/40 bg-indigo-500/10"
      }`}
      label={
        <span className="text-[0.625rem] uppercase tracking-wide text-indigo-300/80 shrink-0">
          ↩ Pediste
        </span>
      }
      preview={f.text}
    >
      <p className="text-zinc-200 whitespace-pre-wrap text-[0.8125rem] leading-relaxed">
        {f.text}
      </p>
      {f.resolved_at ? (
        f.response && (
          <div className="mt-2 pt-2 border-t border-zinc-800/80">
            <div className="text-[0.625rem] uppercase tracking-wide text-emerald-500/70 mb-1">
              ↳ Claude hizo
            </div>
            <div className="md">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{f.response}</ReactMarkdown>
            </div>
          </div>
        )
      ) : (
        <p className="mt-2 text-[0.6875rem] text-indigo-300/70">
          ⏳ pendiente — un worker lo va a retomar
        </p>
      )}
      {questions.length > 0 && (
        <div className="mt-2 space-y-2">
          {[...questions].reverse().map((q) => (
            <QuestionBlock key={q.id} q={q} reload={reload} />
          ))}
        </div>
      )}
    </CollapsibleTurn>
  );
}

function FollowupInput({
  taskId,
  done,
  reload,
}: {
  taskId: number;
  done: boolean;
  reload: () => Promise<unknown>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  async function send() {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await api(`/api/tasks/${taskId}/followups`, "POST", { text });
      setText("");
      await reload();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex gap-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            send();
          }
        }}
        rows={1}
        placeholder={
          done
            ? "Pedir algo más sobre esta tarea… (reabre la task con este contexto)"
            : "Agregar un pedido/contexto al hilo de esta tarea…"
        }
        className={`${INPUT} resize-y`}
      />
      <button
        onClick={send}
        disabled={busy || !text.trim()}
        className="px-3 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs font-medium transition-colors self-start"
      >
        {busy ? "…" : "Pedir"}
      </button>
    </div>
  );
}

interface LogEvent {
  kind: "text" | "tool" | "result" | "run" | "sep";
  text: string;
}

function WorkerActivity({ projectId }: { projectId: number }) {
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [empty, setEmpty] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const fetchLog = useCallback(async () => {
    try {
      const data = await api(`/api/projects/${projectId}/worker-log`, "GET");
      setEvents(data.events ?? []);
      setEmpty(!!data.empty || (data.events ?? []).length === 0);
    } catch {
      /* el server puede no estar — el poll reintenta */
    } finally {
      setLoaded(true);
    }
  }, [projectId]);

  // Poll cada 10s mientras el panel está montado (se monta solo si está abierto).
  useEffect(() => {
    fetchLog();
    const t = setInterval(fetchLog, 10000);
    return () => clearInterval(t);
  }, [fetchLog]);

  // Autoscroll al fondo cuando llegan eventos nuevos.
  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [events]);

  const style: Record<LogEvent["kind"], string> = {
    text: "text-zinc-300",
    tool: "text-sky-300/90",
    result: "text-emerald-300",
    run: "text-amber-300",
    sep: "text-zinc-600 border-t border-zinc-800 mt-1 pt-1",
  };

  return (
    <div className="mb-5 rounded-lg border border-zinc-800 bg-zinc-950/60">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-zinc-800/80 text-[0.6875rem] text-zinc-500">
        <span>actividad del worker · se refresca cada 10s</span>
        <button onClick={fetchLog} className="hover:text-zinc-300" title="Refrescar ahora">
          ↻
        </button>
      </div>
      <div
        ref={boxRef}
        className="max-h-64 overflow-y-auto px-3 py-2 font-mono text-[0.6875rem] leading-relaxed space-y-0.5"
      >
        {!loaded ? (
          <p className="text-zinc-600">cargando…</p>
        ) : empty ? (
          <p className="text-zinc-600">
            Sin actividad registrada todavía. Aparece cuando un worker corre
            (lanzá uno con ▶ Correr ahora).
          </p>
        ) : (
          events.map((e, i) => (
            <div key={i} className={`whitespace-pre-wrap break-words ${style[e.kind]}`}>
              {e.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function Empty() {
  return (
    <div className="h-full flex items-center justify-center text-zinc-600">
      <div className="text-center">
        <TasksLogo box="mx-auto mb-4 h-12 w-12 rounded-2xl" icon="h-7 w-7" />
        <p className="text-lg text-zinc-300">Creá tu primer proyecto</p>
        <p className="text-sm">Usá el botón “+ Proyecto” en la barra lateral.</p>
      </div>
    </div>
  );
}
