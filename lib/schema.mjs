// Single source of truth for the SQLite schema, shared by the Next.js app
// (lib/db.ts) and the standalone CLI (cli/taskapp.mjs).
//
// Hierarchy: project -> document -> task -> question
//   - status: todo | in_progress | blocked | done
//   - stage:  local | develop | production
//   - tested: user-controlled flag (you verified the feature)
//   - question.answered drives the notification badges in the UI.

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS project (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  path          TEXT,
  target_branch TEXT NOT NULL DEFAULT 'develop',
  push_requested INTEGER NOT NULL DEFAULT 0,
  last_push_at  TEXT,
  push_status   TEXT,
  last_seen     TEXT,
  push_stage    TEXT NOT NULL DEFAULT 'develop',
  powered_off_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS document (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS task (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id    INTEGER NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  body           TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'todo',
  tested         INTEGER NOT NULL DEFAULT 0,
  stage          TEXT NOT NULL DEFAULT 'local',
  created_by     TEXT NOT NULL DEFAULT 'user',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_heartbeat TEXT,
  heartbeat_note TEXT,
  summary        TEXT,
  commit_requested INTEGER NOT NULL DEFAULT 0,
  commit_hash    TEXT,
  committed_at   TEXT,
  archived       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS question (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  answer      TEXT,
  answered    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  answered_at TEXT
);

-- Follow-up del humano sobre una task (el "hilo" de la tarea): pedidos
-- adicionales después de que el loop la dio por hecha. Crear uno reabre la
-- task; el loop lo resuelve con el resumen del próximo "taskapp done".
CREATE TABLE IF NOT EXISTS followup (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  response    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

-- Images / files attached to a task. Stored on disk; the loop reads them by path.
CREATE TABLE IF NOT EXISTS attachment (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  filename   TEXT NOT NULL,
  path       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_document_project ON document(project_id);
CREATE INDEX IF NOT EXISTS idx_task_document    ON task(document_id);
CREATE INDEX IF NOT EXISTS idx_question_task    ON question(task_id);
CREATE INDEX IF NOT EXISTS idx_question_open    ON question(answered);
CREATE INDEX IF NOT EXISTS idx_attachment_task  ON attachment(task_id);
CREATE INDEX IF NOT EXISTS idx_followup_task    ON followup(task_id);
`;

// Idempotent migrations for DBs created before a column existed. Safe to run
// on every open. Both the app (lib/db.ts) and the CLI call this after SCHEMA.
export function migrate(db) {
  const cols = (t) =>
    db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  const add = (table, name, ddl) => {
    if (!cols(table).includes(name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  };
  add("task", "last_heartbeat", "last_heartbeat TEXT");
  // Qué está haciendo el worker ahora mismo (lo setea `taskapp heartbeat
  // --note` antes de un comando largo); se limpia en el próximo heartbeat
  // pelado, al cambiar de status o al terminar la task.
  add("task", "heartbeat_note", "heartbeat_note TEXT");
  add("task", "summary", "summary TEXT");
  add("task", "commit_requested", "commit_requested INTEGER NOT NULL DEFAULT 0");
  add("task", "commit_hash", "commit_hash TEXT");
  add("task", "committed_at", "committed_at TEXT");
  add("task", "archived", "archived INTEGER NOT NULL DEFAULT 0");
  add("project", "target_branch", "target_branch TEXT NOT NULL DEFAULT 'develop'");
  add("project", "push_requested", "push_requested INTEGER NOT NULL DEFAULT 0");
  add("project", "last_push_at", "last_push_at TEXT");
  add("project", "push_status", "push_status TEXT");
  add("project", "last_seen", "last_seen TEXT");
  add("project", "push_stage", "push_stage TEXT NOT NULL DEFAULT 'develop'");
  // Workers efímeros lanzados por la app (claude -p). auto_worker habilita el
  // disparo automático por eventos (task nueva, respuesta, follow-up).
  add("project", "auto_worker", "auto_worker INTEGER NOT NULL DEFAULT 0");
  add("project", "worker_pid", "worker_pid INTEGER");
  add("project", "worker_started_at", "worker_started_at TEXT");
  // Modelo de Claude Code para los workers de este proyecto (alias: opus /
  // sonnet / haiku). NULL = default (el último, hoy opus).
  add("project", "worker_model", "worker_model TEXT");
  // Apagado manual: el humano marca el proyecto como "apagado" y queda en el
  // grupo de abajo del sidebar hasta que vuelva a haber actividad del loop
  // (last_seen más reciente que este timestamp) o lo encienda a mano. NULL =
  // no apagado manualmente. Reemplaza el viejo apagado automático por
  // inactividad: un proyecto se mantiene prendido hasta que se decida apagar.
  add("project", "powered_off_at", "powered_off_at TEXT");
}

// Default DB location is location-independent so the CLI works from any
// project directory. Override with the TASKAPP_DB env var.
export function defaultDbPath(homedir) {
  return `${homedir}/.taskapp/taskapp.db`;
}
