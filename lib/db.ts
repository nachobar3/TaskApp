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
  auto_worker: number;
  worker_pid: number | null;
  worker_started_at: string | null;
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
  const info = d
    .prepare("INSERT INTO project (name, path) VALUES (?, ?)")
    .run(name, projectPath ?? null);
  // Every project starts with a default To-Do document.
  d.prepare("INSERT INTO document (project_id, name) VALUES (?, 'To-Do')").run(
    info.lastInsertRowid
  );
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

export function setPushRequested(projectId: number, requested: boolean) {
  db()
    .prepare("UPDATE project SET push_requested = ? WHERE id = ?")
    .run(requested ? 1 : 0, projectId);
}

export function setTargetBranch(projectId: number, branch: string) {
  db()
    .prepare("UPDATE project SET target_branch = ? WHERE id = ?")
    .run(branch, projectId);
}

export function setPushStage(projectId: number, stage: string) {
  db()
    .prepare("UPDATE project SET push_stage = ? WHERE id = ?")
    .run(stage, projectId);
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
  db()
    .prepare(
      "UPDATE question SET answer = ?, answered = 1, answered_at = datetime('now') WHERE id = ?"
    )
    .run(answer, id);
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
