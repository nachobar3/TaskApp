import Database from "better-sqlite3";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { SCHEMA, migrate, defaultDbPath } from "./schema.mjs";

export type Stage = "local" | "develop" | "production";
export type Status = "todo" | "in_progress" | "blocked" | "done";

export interface Project {
  id: number;
  name: string;
  path: string | null;
  target_branch: string;
  push_requested: number;
  last_push_at: string | null;
  push_status: string | null;
  last_seen: string | null;
  push_stage: string;
  powered_off_at: string | null;
  auto_worker: number;
  worker_pid: number | null;
  worker_started_at: string | null;
  worker_model: string | null;
  created_at: string;
}
export interface ProjectBranch {
  id: number;
  project_id: number;
  branch: string;
  stage: string;
  created_at: string;
}
export interface Document {
  id: number;
  project_id: number;
  name: string;
  created_at: string;
}
export interface Task {
  id: number;
  document_id: number;
  title: string;
  body: string;
  status: Status;
  tested: number;
  stage: Stage;
  created_by: string;
  created_at: string;
  updated_at: string;
  last_heartbeat: string | null;
  heartbeat_note: string | null;
  summary: string | null;
  commit_requested: number;
  commit_hash: string | null;
  committed_at: string | null;
  archived: number;
}
export interface Question {
  id: number;
  task_id: number;
  text: string;
  answer: string | null;
  answered: number;
  created_at: string;
  answered_at: string | null;
}
export interface Attachment {
  id: number;
  task_id: number;
  filename: string;
  path: string;
  mime: string;
  created_at: string;
}
export interface Followup {
  id: number;
  task_id: number;
  text: string;
  response: string | null;
  created_at: string;
  resolved_at: string | null;
}

let _db: Database.Database | null = null;

function dbFilePath(): string {
  return process.env.TASKAPP_DB || defaultDbPath(os.homedir());
}

/** Where attachment files live — alongside the DB file. */
export function attachmentsDir(): string {
  return path.join(path.dirname(dbFilePath()), "attachments");
}

export function db(): Database.Database {
  if (_db) return _db;
  const dbPath = dbFilePath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const conn = new Database(dbPath);
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");
  conn.exec(SCHEMA);
  migrate(conn);
  _db = conn;
  return conn;
}

/** Is the given OS process still alive? (signal 0 = existence check) */
export function pidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Full snapshot the UI polls — projects with nested documents, tasks, questions. */
export function getState() {
  const d = db();
  const projects = d.prepare("SELECT * FROM project ORDER BY id").all() as Project[];
  const branches = d
    .prepare("SELECT * FROM project_branch ORDER BY id")
    .all() as ProjectBranch[];
  const documents = d.prepare("SELECT * FROM document ORDER BY id").all() as Document[];
  const tasks = d
    .prepare("SELECT * FROM task ORDER BY id DESC")
    .all() as Task[];
  const questions = d
    .prepare("SELECT * FROM question ORDER BY id")
    .all() as Question[];
  const attachments = d
    .prepare("SELECT * FROM attachment ORDER BY id")
    .all() as Attachment[];
  const followups = d
    .prepare("SELECT * FROM followup ORDER BY id")
    .all() as Followup[];

  return projects.map((p) => ({
    ...p,
    push_requested: !!p.push_requested,
    auto_worker: !!p.auto_worker,
    worker_running: pidAlive(p.worker_pid),
    branches: branches
      .filter((b) => b.project_id === p.id)
      .map((b) => ({ id: b.id, branch: b.branch, stage: b.stage })),
    documents: documents
      .filter((doc) => doc.project_id === p.id)
      .map((doc) => ({
        ...doc,
        tasks: tasks
          .filter((t) => t.document_id === doc.id)
          .map((t) => ({
            ...t,
            tested: !!t.tested,
            archived: !!t.archived,
            commit_requested: !!t.commit_requested,
            questions: questions
              .filter((q) => q.task_id === t.id)
              .map((q) => ({ ...q, answered: !!q.answered })),
            followups: followups.filter((f) => f.task_id === t.id),
            // Don't leak absolute disk paths to the browser — id is enough to
            // fetch the bytes via /api/attachments/<id>.
            attachments: attachments
              .filter((a) => a.task_id === t.id)
              .map((a) => ({ id: a.id, filename: a.filename, mime: a.mime })),
          })),
      })),
  }));
}

export function createProject(name: string, projectPath?: string) {
  const d = db();
  // New projects start pointing at main → production (the single default push
  // destination). The human can add more branch → stage pairs from the UI.
  const info = d
    .prepare(
      "INSERT INTO project (name, path, target_branch, push_stage) VALUES (?, ?, 'main', 'production')"
    )
    .run(name, projectPath ?? null);
  // Every project starts with a default To-Do document.
  d.prepare("INSERT INTO document (project_id, name) VALUES (?, 'To-Do')").run(
    info.lastInsertRowid
  );
  // Seed the push-destination catalog with main → production.
  d.prepare(
    "INSERT INTO project_branch (project_id, branch, stage) VALUES (?, 'main', 'production')"
  ).run(info.lastInsertRowid);
  return info.lastInsertRowid as number;
}

// Unlink attachment files from disk so deletes don't leave orphans (the DB
// rows go away via ON DELETE CASCADE, but the files would remain).
function rmAttachmentFiles(rows: { path: string }[]) {
  for (const r of rows) {
    try {
      fs.rmSync(r.path, { force: true });
    } catch {
      // ignore
    }
  }
}

export function deleteProject(id: number) {
  rmAttachmentFiles(
    db()
      .prepare(
        `SELECT a.path FROM attachment a
           JOIN task t ON t.id = a.task_id
           JOIN document d ON d.id = t.document_id
          WHERE d.project_id = ?`
      )
      .all(id) as { path: string }[]
  );
  db().prepare("DELETE FROM project WHERE id = ?").run(id);
}

export function createDocument(projectId: number, name: string) {
  return db()
    .prepare("INSERT INTO document (project_id, name) VALUES (?, ?)")
    .run(projectId, name).lastInsertRowid as number;
}

export function deleteDocument(id: number) {
  rmAttachmentFiles(
    db()
      .prepare(
        `SELECT a.path FROM attachment a
           JOIN task t ON t.id = a.task_id
          WHERE t.document_id = ?`
      )
      .all(id) as { path: string }[]
  );
  db().prepare("DELETE FROM document WHERE id = ?").run(id);
}

export function createTask(
  documentId: number,
  title: string,
  body = "",
  createdBy = "user"
) {
  return db()
    .prepare(
      "INSERT INTO task (document_id, title, body, created_by) VALUES (?, ?, ?, ?)"
    )
    .run(documentId, title, body, createdBy).lastInsertRowid as number;
}

const TASK_FIELDS = [
  "title",
  "body",
  "status",
  "tested",
  "stage",
  "summary",
  "archived",
] as const;

export function updateTask(
  id: number,
  patch: Partial<
    Pick<
      Task,
      "title" | "body" | "status" | "tested" | "stage" | "summary" | "archived"
    >
  >
) {
  const keys = Object.keys(patch).filter((k) =>
    (TASK_FIELDS as readonly string[]).includes(k)
  );
  if (keys.length === 0) return;
  const setParts = keys.map((k) => `${k} = @${k}`);
  // Claiming a task (status -> in_progress) counts as a heartbeat.
  if (patch.status === "in_progress") setParts.push("last_heartbeat = datetime('now')");
  // Cambiar de status invalida la nota "qué estoy haciendo ahora" del worker.
  if (patch.status) setParts.push("heartbeat_note = NULL");
  const values: Record<string, unknown> = { id };
  for (const k of keys) {
    values[k] =
      k === "tested" || k === "archived"
        ? ((patch as never)[k] ? 1 : 0)
        : (patch as never)[k];
  }
  db()
    .prepare(
      `UPDATE task SET ${setParts.join(", ")}, updated_at = datetime('now') WHERE id = @id`
    )
    .run(values);
}

/** Mark a task as actively worked on right now (used by the loop). */
export function heartbeatTask(id: number) {
  db()
    .prepare("UPDATE task SET last_heartbeat = datetime('now') WHERE id = ?")
    .run(id);
}

// --- git requests (the loop performs the actual git; the app sets requests) ---

export function setCommitRequested(taskId: number, requested: boolean) {
  db()
    .prepare(
      "UPDATE task SET commit_requested = ?, updated_at = datetime('now') WHERE id = ?"
    )
    .run(requested ? 1 : 0, taskId);
}

/**
 * Mark every done, not-yet-committed, not-archived task of a project as
 * pending commit. Returns how many tasks were newly flagged.
 */
export function requestCommitAllDone(projectId: number): number {
  const info = db()
    .prepare(
      `UPDATE task SET commit_requested = 1, updated_at = datetime('now')
         WHERE commit_requested = 0
           AND status = 'done'
           AND commit_hash IS NULL
           AND archived = 0
           AND document_id IN (SELECT id FROM document WHERE project_id = ?)`
    )
    .run(projectId);
  return info.changes;
}

export function setPushRequested(projectId: number, requested: boolean) {
  db()
    .prepare("UPDATE project SET push_requested = ? WHERE id = ?")
    .run(requested ? 1 : 0, projectId);
}

/** Select the active push destination (branch + stage) the loop will push to. */
export function setPushDestination(
  projectId: number,
  branch: string,
  stage: string
) {
  db()
    .prepare("UPDATE project SET target_branch = ?, push_stage = ? WHERE id = ?")
    .run(branch, stage, projectId);
}

// --- push destinations catalog (branch -> stage pairs per project) ---------

export function listProjectBranches(projectId: number): ProjectBranch[] {
  return db()
    .prepare("SELECT * FROM project_branch WHERE project_id = ? ORDER BY id")
    .all(projectId) as ProjectBranch[];
}

/** Add a branch → stage destination. Idempotent on (project, branch). */
export function addProjectBranch(
  projectId: number,
  branch: string,
  stage: string
) {
  db()
    .prepare(
      "INSERT INTO project_branch (project_id, branch, stage) VALUES (?, ?, ?) " +
        "ON CONFLICT(project_id, branch) DO UPDATE SET stage = excluded.stage"
    )
    .run(projectId, branch, stage);
}

/** Remove a destination, but never leave a project with zero destinations. */
export function deleteProjectBranch(projectId: number, branchId: number) {
  const d = db();
  const count = d
    .prepare("SELECT COUNT(*) c FROM project_branch WHERE project_id = ?")
    .get(projectId) as { c: number };
  if (count.c <= 1) return false;
  d.prepare(
    "DELETE FROM project_branch WHERE id = ? AND project_id = ?"
  ).run(branchId, projectId);
  // If we just deleted the currently-selected destination, fall back to the
  // first remaining one so target_branch/push_stage never dangle.
  const proj = d
    .prepare("SELECT target_branch FROM project WHERE id = ?")
    .get(projectId) as { target_branch: string } | undefined;
  const stillThere = d
    .prepare("SELECT 1 FROM project_branch WHERE project_id = ? AND branch = ?")
    .get(projectId, proj?.target_branch);
  if (!stillThere) {
    const first = d
      .prepare(
        "SELECT branch, stage FROM project_branch WHERE project_id = ? ORDER BY id LIMIT 1"
      )
      .get(projectId) as { branch: string; stage: string } | undefined;
    if (first) {
      d.prepare(
        "UPDATE project SET target_branch = ?, push_stage = ? WHERE id = ?"
      ).run(first.branch, first.stage, projectId);
    }
  }
  return true;
}

export function deleteTask(id: number) {
  rmAttachmentFiles(
    db()
      .prepare("SELECT path FROM attachment WHERE task_id = ?")
      .all(id) as { path: string }[]
  );
  db().prepare("DELETE FROM task WHERE id = ?").run(id);
}

export function createQuestion(taskId: number, text: string) {
  return db()
    .prepare("INSERT INTO question (task_id, text) VALUES (?, ?)")
    .run(taskId, text).lastInsertRowid as number;
}

export function answerQuestion(id: number, answer: string) {
  const d = db();
  d.prepare(
    "UPDATE question SET answer = ?, answered = 1, answered_at = datetime('now') WHERE id = ?"
  ).run(answer, id);
  // Si la task estaba bloqueada por esta pregunta y ya no le quedan preguntas
  // abiertas, devolvela a `todo`: el worker solo procesa todo/in_progress, así
  // que una task que sigue `blocked` nunca sería retomada al responderla.
  const q = d.prepare("SELECT task_id FROM question WHERE id = ?").get(id) as
    | { task_id: number }
    | undefined;
  if (!q) return;
  const open = d
    .prepare(
      "SELECT COUNT(*) c FROM question WHERE task_id = ? AND answered = 0"
    )
    .get(q.task_id) as { c: number };
  if (open.c === 0) {
    d.prepare(
      "UPDATE task SET status = 'todo', updated_at = datetime('now') WHERE id = ? AND status = 'blocked'"
    ).run(q.task_id);
  }
}

export function taskExists(id: number): boolean {
  return !!db().prepare("SELECT 1 FROM task WHERE id = ?").get(id);
}

export function createAttachment(
  taskId: number,
  filename: string,
  filePath: string,
  mime: string
): Attachment {
  const info = db()
    .prepare(
      "INSERT INTO attachment (task_id, filename, path, mime) VALUES (?, ?, ?, ?)"
    )
    .run(taskId, filename, filePath, mime);
  return db()
    .prepare("SELECT * FROM attachment WHERE id = ?")
    .get(info.lastInsertRowid) as Attachment;
}

export function getAttachment(id: number): Attachment | undefined {
  return db().prepare("SELECT * FROM attachment WHERE id = ?").get(id) as
    | Attachment
    | undefined;
}

export function deleteAttachment(id: number) {
  db().prepare("DELETE FROM attachment WHERE id = ?").run(id);
}

// --- followups (el "hilo" de una task: pedidos del humano post-done) -------

/**
 * Add a human follow-up to a task. If the task was done, it reopens (status →
 * todo) so a worker/loop picks it up as a continuation of the same thread.
 */
export function createFollowup(taskId: number, text: string) {
  const d = db();
  const info = d
    .prepare("INSERT INTO followup (task_id, text) VALUES (?, ?)")
    .run(taskId, text);
  d.prepare(
    "UPDATE task SET status = CASE WHEN status = 'done' THEN 'todo' ELSE status END, updated_at = datetime('now') WHERE id = ?"
  ).run(taskId);
  return info.lastInsertRowid as number;
}

// --- workers (procesos claude -p lanzados por la app) ----------------------

export function getProject(id: number): Project | undefined {
  return db().prepare("SELECT * FROM project WHERE id = ?").get(id) as
    | Project
    | undefined;
}

export function setAutoWorker(projectId: number, enabled: boolean) {
  db()
    .prepare("UPDATE project SET auto_worker = ? WHERE id = ?")
    .run(enabled ? 1 : 0, projectId);
}

/**
 * Apagado/encendido manual de un proyecto. `off=true` lo marca apagado ahora;
 * `off=false` limpia la marca. El proyecto vuelve a prenderse solo si el loop
 * registra actividad posterior (last_seen) o se lo enciende a mano.
 */
export function setPoweredOff(projectId: number, off: boolean) {
  db()
    .prepare(
      "UPDATE project SET powered_off_at = CASE WHEN ? THEN datetime('now') ELSE NULL END WHERE id = ?"
    )
    .run(off ? 1 : 0, projectId);
}

export function setWorkerModel(projectId: number, model: string) {
  db()
    .prepare("UPDATE project SET worker_model = ? WHERE id = ?")
    .run(model, projectId);
}

export function setWorkerPid(projectId: number, pid: number | null) {
  db()
    .prepare(
      "UPDATE project SET worker_pid = ?, worker_started_at = CASE WHEN ? IS NULL THEN worker_started_at ELSE datetime('now') END WHERE id = ?"
    )
    .run(pid, pid, projectId);
}

export function projectIdForDocument(documentId: number): number | undefined {
  const row = db()
    .prepare("SELECT project_id FROM document WHERE id = ?")
    .get(documentId) as { project_id: number } | undefined;
  return row?.project_id;
}

export function projectIdForTask(taskId: number): number | undefined {
  const row = db()
    .prepare(
      "SELECT d.project_id FROM task t JOIN document d ON d.id = t.document_id WHERE t.id = ?"
    )
    .get(taskId) as { project_id: number } | undefined;
  return row?.project_id;
}

export function projectIdForQuestion(questionId: number): number | undefined {
  const row = db()
    .prepare(
      `SELECT d.project_id FROM question q
         JOIN task t ON t.id = q.task_id
         JOIN document d ON d.id = t.document_id
        WHERE q.id = ?`
    )
    .get(questionId) as { project_id: number } | undefined;
  return row?.project_id;
}
