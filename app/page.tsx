"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  DocumentView,
  ProjectView,
  Stage,
  TaskView,
  openQuestionCount,
} from "@/lib/types";

const STAGES: Stage[] = ["local", "develop", "production"];
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

// A project is "prendido" (loop running) if its CLI was seen within this window.
// The idle loop polls every ~5 min, so 8 min avoids flicker while idle.
const PROJECT_ACTIVE_MS = 8 * 60 * 1000;

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

async function uploadAttachment(taskId: number, file: File) {
  const fd = new FormData();
  fd.append("file", file);
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

  const isActive = (p: ProjectView) =>
    p.worker_running ||
    (!!p.last_seen && now - parseUTC(p.last_seen) < PROJECT_ACTIVE_MS);
  // Projects waiting for an answer bubble to the top of their group.
  const waitingFirst = (a: ProjectView, b: ProjectView) =>
    (openQuestionCount(b) > 0 ? 1 : 0) - (openQuestionCount(a) > 0 ? 1 : 0);
  const on = projects.filter(isActive).sort(waitingFirst);
  const off = projects.filter((p) => !isActive(p)).sort(waitingFirst);

  // El loop dejó novedades sin ver: produjo actividad después de la última vez
  // que abriste el proyecto. Se omite si hay preguntas abiertas (esas ya gritan
  // en rojo con su propio indicador).
  const isUnseen = (p: ProjectView) =>
    openQuestionCount(p) === 0 &&
    loopActivityAt(p) > (seen[p.id] ?? Number.MAX_SAFE_INTEGER);

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
              placeholder="Path (opcional)"
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
  const [branch, setBranch] = useState(project.target_branch);
  const now = Date.now();

  const tasksToCommit = project.documents
    .flatMap((d) => d.tasks)
    .filter((t) => t.commit_requested).length;

  async function createDoc() {
    if (!docName.trim()) return;
    await api("/api/documents", "POST", { project_id: project.id, name: docName });
    setDocName("");
    setAddingDoc(false);
    await reload();
  }

  async function removeProject() {
    if (!confirm(`¿Borrar el proyecto "${project.name}" y todo su contenido?`)) return;
    await api(`/api/projects/${project.id}`, "DELETE");
    await reload();
  }

  async function saveBranch() {
    if (!branch.trim() || branch.trim() === project.target_branch) return;
    await api(`/api/projects/${project.id}`, "PATCH", { target_branch: branch.trim() });
    await reload();
  }

  async function savePushStage(stage: string) {
    await api(`/api/projects/${project.id}`, "PATCH", { push_stage: stage });
    await reload();
  }

  async function requestPush() {
    if (
      !confirm(
        `Pedir push a la rama "${project.target_branch}" (las tasks pasan a stage "${project.push_stage}").\n\nEl loop, en su próxima iteración, va a commitear las tasks marcadas (${tasksToCommit}) y pushear. ¿Seguir?`
      )
    )
      return;
    await api(`/api/projects/${project.id}/push-request`, "POST", {});
    await reload();
  }

  async function cancelPush() {
    await api(`/api/projects/${project.id}/push-request`, "POST", { requested: false });
    await reload();
  }

  async function toggleAutoWorker() {
    await api(`/api/projects/${project.id}`, "PATCH", {
      auto_worker: !project.auto_worker,
    });
    await reload();
  }

  async function runWorkerNow() {
    try {
      await api(`/api/projects/${project.id}/worker`, "POST", {});
    } catch (e) {
      alert(e instanceof Error ? e.message : "No se pudo lanzar el worker");
    }
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
      </div>

      {/* Git / push bar */}
      <div className="flex flex-wrap items-center gap-3 mb-5 text-xs">
        <div className="flex items-center gap-1.5">
          <span className="text-zinc-500">rama destino</span>
          <input
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            onBlur={saveBranch}
            onKeyDown={(e) => e.key === "Enter" && saveBranch()}
            className="w-28 px-2 py-1 rounded-md bg-zinc-800/70 border border-zinc-700 text-zinc-100 font-mono outline-none focus:border-indigo-500"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-zinc-500">→ stage</span>
          <select
            value={project.push_stage}
            onChange={(e) => savePushStage(e.target.value)}
            className={`px-2 py-1 rounded-md border outline-none cursor-pointer ${STAGE_STYLE[project.push_stage as Stage] ?? STAGE_STYLE.develop}`}
            title="A qué stage pasan las tasks cuando se pushea a esta rama"
          >
            <option value="develop">develop</option>
            <option value="production">production</option>
          </select>
        </div>
        {project.push_requested ? (
          <span className="inline-flex items-center gap-2 px-2.5 py-1 rounded-md border border-amber-500/40 bg-amber-500/15 text-amber-300">
            ⏳ push pedido a {project.target_branch} — el loop lo ejecutará
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
          >
            ⬆ Push a {project.target_branch} (→ {project.push_stage})
            {tasksToCommit > 0 ? ` · ${tasksToCommit} a commitear` : ""}
          </button>
        )}
        {project.last_push_at && (
          <span
            className={
              project.push_status?.startsWith("error")
                ? "text-rose-400"
                : "text-zinc-500"
            }
          >
            último push: {project.push_status} · {timeAgo(project.last_push_at, now)}
          </span>
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

  // Visible: everything still living in local/develop. Collapsed: production
  // (incluye lo archivado, que también queda como production).
  const inProd = doc.tasks.filter((t) => t.stage === "production");
  const visible = doc.tasks
    .filter((t) => t.stage !== "production")
    // pending tasks first, completed-but-not-prod below
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
            {busy ? "Creando…" : "Crear task"}
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

      {inProd.length > 0 && (
        <details className="pt-1">
          <summary className="cursor-pointer text-emerald-500/70 hover:text-emerald-400 text-xs uppercase tracking-wide select-none">
            En producción ({inProd.length})
          </summary>
          <div className="space-y-3 mt-3">
            {inProd.map((t) => (
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
  // Las tasks con novedad del loop sin ver arrancan expandidas al abrir el
  // proyecto; el resto, colapsadas.
  const [expanded, setExpanded] = useState(unseen);
  useEffect(() => {
    // Al mostrarlas ya expandidas las damos por vistas; si no, se volverían a
    // auto-expandir en cada visita. Solo corre al montar.
    if (unseen) onSeen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
          className="shrink-0 w-4 text-center text-zinc-500 hover:text-zinc-200 transition-colors"
          title={expanded ? "Colapsar" : "Expandir"}
        >
          {expanded ? "▾" : "▸"}
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
          className={`flex-1 min-w-0 font-medium truncate cursor-pointer ${
            isDone ? "line-through text-zinc-600" : "text-zinc-100"
          }`}
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
              className="inline-flex items-center gap-1.5 text-[0.6875rem] px-2 py-0.5 rounded-full border border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
              title={`última señal ${timeAgo(task.last_heartbeat!, now)}`}
            >
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
              </span>
              trabajando
            </span>
          ) : workerBusy ? (
            <span
              className="inline-flex items-center gap-1.5 text-[0.6875rem] px-2 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-300/90"
              title="El worker está corriendo pero sin señal reciente — típico de un comando largo (tests, build)."
            >
              <span className="h-2 w-2 rounded-full bg-emerald-400/70" />
              worker activo
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
          {committed && (
            <span
              className="hidden sm:inline text-[0.6875rem] px-1.5 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/15 text-emerald-300 font-mono"
              title={`commiteado ${task.committed_at ? timeAgo(task.committed_at, now) : ""}`}
            >
              ✓ {task.commit_hash!.slice(0, 7)}
            </span>
          )}
          {task.tested && (
            <span
              className="hidden sm:inline text-[0.6875rem] px-1.5 py-0.5 rounded-full border border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
              title="Probaste esta feature"
            >
              ✓ tested
            </span>
          )}
        </div>
      </div>

      {/* Detalle — solo cuando está expandida */}
      {expanded && (
        <div className="mt-3 pl-1.5 sm:pl-6 space-y-3">
          {editing ? (
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
          ) : (
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
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {task.summary}
                    </ReactMarkdown>
                  </div>
                </div>
              ) : (
                isDone && (
                  <p className="text-[0.6875rem] text-amber-400/70">
                    ⚠ Tarea hecha sin resumen.
                  </p>
                )
              )}
            </>
          )}

          {task.attachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {task.attachments.map((a) => (
                <AttachmentThumb key={a.id} a={a} reload={reload} />
              ))}
            </div>
          )}

          {task.questions.length > 0 && (
            <div className="space-y-2">
              {task.questions.map((q) => (
                <QuestionBlock key={q.id} q={q} reload={reload} />
              ))}
            </div>
          )}

          {/* Hilo: pedidos posteriores del humano sobre esta misma task */}
          {task.followups.length > 0 && (
            <div className="space-y-2">
              {task.followups.map((f) => (
                <FollowupBlock key={f.id} f={f} />
              ))}
            </div>
          )}
          {!editing && <FollowupInput taskId={task.id} done={isDone} reload={reload} />}

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

            <select
              value={task.stage}
              onChange={(e) => patch({ stage: e.target.value })}
              className={`text-sm rounded-md border px-2.5 py-1.5 outline-none cursor-pointer ${STAGE_STYLE[task.stage]}`}
            >
              {STAGES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>

            {committed ? (
              <span
                className="text-[0.6875rem] px-2 py-1 rounded-full border border-emerald-500/30 bg-emerald-500/15 text-emerald-300 font-mono"
                title={`commiteado ${task.committed_at ? timeAgo(task.committed_at, now) : ""}`}
              >
                ✓ {task.commit_hash!.slice(0, 7)}
              </span>
            ) : commitPending ? (
              <span
                className="inline-flex items-center gap-1 text-[0.6875rem] px-2 py-1 rounded-full border border-amber-500/40 bg-amber-500/15 text-amber-300"
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
                className="text-[0.6875rem] px-2 py-1 rounded-full border border-zinc-700 text-zinc-400 hover:text-emerald-300 hover:border-emerald-500/40 transition-colors"
                title="Pedir que el loop commitee esta task"
              >
                commit
              </button>
            )}
            <button
              onClick={() => patch({ tested: !task.tested })}
              className={`inline-flex items-center gap-1 text-[0.6875rem] px-2 py-1 rounded-full border transition-colors ${
                task.tested
                  ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                  : "border-zinc-700 text-zinc-400 hover:border-emerald-500/40 hover:text-emerald-300"
              }`}
              title="Marcar que probaste la feature"
            >
              {task.tested ? "✓ tested" : "tested"}
            </button>
            {task.stage !== "production" && (
              <button
                onClick={() => patch({ stage: "production", status: "done" })}
                className="text-[0.6875rem] px-2 py-1 rounded-full border border-zinc-700 text-zinc-400 hover:text-emerald-300 hover:border-emerald-500/40 transition-colors"
                title="Archivar: la da por hecha y la manda a 'En producción' (colapsado abajo)"
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
  return (
    <span
      className={`text-[0.625rem] px-1.5 py-0.5 rounded border ${map[status] ?? map.todo}`}
    >
      {status.replace("_", " ")}
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
  async function send() {
    if (!answer.trim()) return;
    await api(`/api/questions/${q.id}/answer`, "POST", { answer });
    setAnswer("");
    await reload();
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
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3">
      <div className="text-[0.625rem] uppercase tracking-wide text-rose-300/80 mb-1">
        ❓ Claude pregunta
      </div>
      <div className="md">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{q.text}</ReactMarkdown>
      </div>
      <div className="flex gap-2 mt-3">
        <textarea
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          placeholder="Tu respuesta… (Enter = nueva línea · Ctrl/⌘+Enter = enviar)"
          className="flex-1 px-2.5 py-1.5 rounded-md bg-zinc-900 border border-rose-500/40 text-zinc-100 placeholder-zinc-500 outline-none focus:border-rose-400 resize-y"
        />
        <button
          onClick={send}
          className="px-3 py-1.5 rounded-md bg-rose-600 hover:bg-rose-500 text-white text-xs font-medium transition-colors self-start"
        >
          Responder
        </button>
      </div>
    </div>
  );
}

function FollowupBlock({ f }: { f: TaskView["followups"][number] }) {
  return (
    <div
      className={`rounded-lg border p-3 ${
        f.resolved_at
          ? "border-zinc-800 bg-zinc-800/40"
          : "border-indigo-500/40 bg-indigo-500/10"
      }`}
    >
      <div className="text-[0.625rem] uppercase tracking-wide text-indigo-300/80 mb-1">
        ↩ Pediste
      </div>
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
    </div>
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
