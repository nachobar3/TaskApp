#!/usr/bin/env node
// TaskApp CLI — used by Claude loops to read/write tasks and questions.
// Talks directly to the shared SQLite file, so it works whether or not the
// web UI is running. DB location: $TASKAPP_DB or ~/.taskapp/taskapp.db
//
// Run `taskapp help` for the full command list.

import Database from "better-sqlite3";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA, migrate, defaultDbPath } from "../lib/schema.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
void __dirname;

function openDb() {
  const dbPath = process.env.TASKAPP_DB || defaultDbPath(os.homedir());
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// --- tiny arg parser: positionals + --flag value / --bool ----------------
function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const nxt = argv[i + 1];
      if (nxt === undefined || nxt.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = nxt;
        i++;
      }
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
}

function out(flags, data, human) {
  if (flags.json) {
    console.log(JSON.stringify(data, null, 2));
  } else if (typeof human === "function") {
    human(data);
  } else {
    console.log(human ?? "");
  }
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

// Read a task summary from --summary "...", --summary-file <path>, or
// --summary-stdin. The file/stdin forms avoid shell-escaping problems when the
// summary is long markdown with backticks, quotes or $.
function readSummary(flags) {
  if (flags.summary && flags.summary !== true) return String(flags.summary);
  if (flags["summary-file"] && flags["summary-file"] !== true) {
    return fs.readFileSync(String(flags["summary-file"]), "utf8");
  }
  if (flags["summary-stdin"]) return fs.readFileSync(0, "utf8");
  return undefined;
}

// Find the project whose `path` is the current directory or its closest
// ancestor. This is what makes association automatic: run the CLI from inside
// a repo and it knows which project you mean — no --project needed.
// Record that the loop touched this project just now → drives the "prendido"
// indicator in the UI. Any CLI command that resolves a project bumps it.
function touchProject(db, id) {
  db.prepare("UPDATE project SET last_seen = datetime('now') WHERE id = ?").run(id);
}

function resolveProjectByCwd(db, touch = true) {
  const cwd = path.resolve(process.cwd());
  const rows = db
    .prepare("SELECT * FROM project WHERE path IS NOT NULL AND path != ''")
    .all();
  let best = null;
  let bestLen = -1;
  for (const p of rows) {
    const base = path.resolve(String(p.path)).replace(/\/+$/, "");
    if (cwd === base || cwd.startsWith(base + path.sep)) {
      if (base.length > bestLen) {
        best = p;
        bestLen = base.length;
      }
    }
  }
  if (best && touch) touchProject(db, best.id);
  return best;
}

function resolveProject(db, ref) {
  if (ref && ref !== true) {
    let row = null;
    if (/^\d+$/.test(String(ref))) {
      row = db.prepare("SELECT * FROM project WHERE id = ?").get(Number(ref));
    }
    if (!row) row = db.prepare("SELECT * FROM project WHERE name = ?").get(String(ref));
    if (!row) fail(`project not found: ${ref}`);
    touchProject(db, row.id);
    return row;
  }
  // No --project given: resolve by current directory.
  const byCwd = resolveProjectByCwd(db);
  if (byCwd) return byCwd;
  fail(
    `no --project given and no project's path matches the current directory:\n  ${process.cwd()}\n` +
      `Set the project's path in the TaskApp UI to this directory, or pass --project "<name>".`
  );
}

function resolveDocument(db, project, docRef) {
  if (docRef) {
    let row = null;
    if (/^\d+$/.test(String(docRef))) {
      row = db
        .prepare("SELECT * FROM document WHERE id = ? AND project_id = ?")
        .get(Number(docRef), project.id);
    }
    if (!row) {
      row = db
        .prepare("SELECT * FROM document WHERE name = ? AND project_id = ?")
        .get(String(docRef), project.id);
    }
    if (!row) fail(`document not found in project ${project.name}: ${docRef}`);
    return row;
  }
  // default: first document of the project
  const row = db
    .prepare("SELECT * FROM document WHERE project_id = ? ORDER BY id LIMIT 1")
    .get(project.id);
  if (!row) fail(`project ${project.name} has no documents`);
  return row;
}

// --- commands -------------------------------------------------------------
const commands = {
  help() {
    console.log(HELP);
  },

  "db-path"() {
    console.log(process.env.TASKAPP_DB || defaultDbPath(os.homedir()));
  },

  // Which project does the current directory map to? (auto path association)
  whoami(db, { flags }) {
    const p = resolveProjectByCwd(db);
    out(
      flags,
      p ? { project: p.name, id: p.id, path: p.path, cwd: process.cwd() } : { project: null, cwd: process.cwd() },
      (x) =>
        x.project
          ? console.log(`${x.project}  (#${x.id})\n  cwd: ${x.cwd}\n  path: ${x.path}`)
          : console.log(`(ningún proyecto asociado a ${x.cwd})`)
    );
  },

  projects(db, { flags }) {
    const rows = db.prepare("SELECT * FROM project ORDER BY id").all();
    out(flags, rows, (r) =>
      r.length
        ? r.forEach((p) => console.log(`#${p.id}  ${p.name}${p.path ? `  (${p.path})` : ""}`))
        : console.log("(no projects)")
    );
  },

  // Idempotent: create the project (and a default To-Do doc) if missing.
  "ensure-project"(db, { flags }) {
    const name = flags.name;
    if (!name || name === true) fail("ensure-project requires --name");
    let p = db.prepare("SELECT * FROM project WHERE name = ?").get(name);
    if (!p) {
      const info = db
        .prepare(
          "INSERT INTO project (name, path, target_branch, push_stage) VALUES (?, ?, 'main', 'production')"
        )
        .run(name, flags.path && flags.path !== true ? flags.path : null);
      db.prepare("INSERT INTO document (project_id, name) VALUES (?, 'To-Do')").run(
        info.lastInsertRowid
      );
      // Seed the push-destination catalog with main → production.
      db.prepare(
        "INSERT INTO project_branch (project_id, branch, stage) VALUES (?, 'main', 'production')"
      ).run(info.lastInsertRowid);
      p = db.prepare("SELECT * FROM project WHERE id = ?").get(info.lastInsertRowid);
    } else if (flags.path && flags.path !== true && !p.path) {
      db.prepare("UPDATE project SET path = ? WHERE id = ?").run(flags.path, p.id);
    }
    out(flags, p, (x) => console.log(`#${x.id}  ${x.name}`));
  },

  "ensure-document"(db, { flags }) {
    const project = resolveProject(db, flags.project);
    const name = flags.name;
    if (!name || name === true) fail("ensure-document requires --name");
    let d = db
      .prepare("SELECT * FROM document WHERE project_id = ? AND name = ?")
      .get(project.id, name);
    if (!d) {
      const info = db
        .prepare("INSERT INTO document (project_id, name) VALUES (?, ?)")
        .run(project.id, name);
      d = db.prepare("SELECT * FROM document WHERE id = ?").get(info.lastInsertRowid);
    }
    out(flags, d, (x) => console.log(`#${x.id}  ${x.name}`));
  },

  // List tasks for a project. --status filters (comma list). --document scopes.
  tasks(db, { flags }) {
    const project = resolveProject(db, flags.project);
    const docs = flags.document
      ? [resolveDocument(db, project, flags.document)]
      : db.prepare("SELECT * FROM document WHERE project_id = ? ORDER BY id").all(project.id);
    const docIds = docs.map((d) => d.id);
    if (docIds.length === 0) return out(flags, [], () => console.log("(no tasks)"));

    const placeholders = docIds.map(() => "?").join(",");
    let rows = db
      .prepare(`SELECT * FROM task WHERE document_id IN (${placeholders}) ORDER BY id`)
      .all(...docIds);

    if (flags.status && flags.status !== true) {
      const wanted = new Set(String(flags.status).split(",").map((s) => s.trim()));
      rows = rows.filter((t) => wanted.has(t.status));
    }
    const docName = Object.fromEntries(docs.map((d) => [d.id, d.name]));
    const enriched = rows.map((t) => {
      const openQ = db
        .prepare("SELECT COUNT(*) c FROM question WHERE task_id = ? AND answered = 0")
        .get(t.id).c;
      const attachments = db
        .prepare("SELECT path FROM attachment WHERE task_id = ? ORDER BY id")
        .all(t.id)
        .map((r) => r.path);
      // Pedidos del humano posteriores al done: la task es una continuación.
      const openFollowups = db
        .prepare(
          "SELECT id, text, created_at FROM followup WHERE task_id = ? AND resolved_at IS NULL ORDER BY id"
        )
        .all(t.id);
      return {
        ...t,
        tested: !!t.tested,
        document: docName[t.document_id],
        open_questions: openQ,
        open_followups: openFollowups,
        attachments,
      };
    });

    out(flags, enriched, (r) =>
      r.length
        ? r.forEach((t) =>
            console.log(
              `#${t.id} [${t.status}] [${t.stage}]${t.tested ? " ✓tested" : ""}` +
                `${t.open_questions ? ` (${t.open_questions} pregunta sin responder)` : ""}` +
                `${t.open_followups.length ? ` (↩ ${t.open_followups.length} follow-up pendiente)` : ""}` +
                `${t.attachments.length ? ` 📎${t.attachments.length}` : ""}  ${t.title}`
            )
          )
        : console.log("(no tasks)")
    );
  },

  show(db, { pos, flags }) {
    const id = Number(pos[0]);
    if (!id) fail("show requires a task id");
    const t = db.prepare("SELECT * FROM task WHERE id = ?").get(id);
    if (!t) fail(`task not found: ${id}`);
    const allAtt = db
      .prepare(
        "SELECT id, question_id, filename, path, mime FROM attachment WHERE task_id = ? ORDER BY id"
      )
      .all(id);
    const questions = db
      .prepare("SELECT * FROM question WHERE task_id = ? ORDER BY id")
      .all(id)
      .map((q) => ({
        ...q,
        answered: !!q.answered,
        attachments: allAtt.filter((a) => a.question_id === q.id),
      }));
    // Adjuntos a nivel task (los de respuestas se listan bajo su pregunta).
    const attachments = allAtt.filter((a) => a.question_id == null);
    const followups = db
      .prepare("SELECT * FROM followup WHERE task_id = ? ORDER BY id")
      .all(id);
    const data = { ...t, tested: !!t.tested, questions, attachments, followups };
    out(flags, data, (x) => {
      console.log(`#${x.id} [${x.status}] [${x.stage}]${x.tested ? " ✓tested" : ""}  ${x.title}`);
      if (x.body) console.log(x.body);
      if (x.summary) {
        console.log("\n--- Resumen ---");
        console.log(x.summary);
        console.log("---------------");
      }
      for (const a of x.attachments) {
        console.log(`  📎 ${a.path}`);
      }
      for (const q of x.questions) {
        console.log(`  Q#${q.id}: ${q.text}`);
        console.log(`    ${q.answered ? `A: ${q.answer}` : "(sin responder)"}`);
        for (const a of q.attachments) {
          console.log(`      📎 ${a.path}`);
        }
      }
      for (const f of x.followups) {
        console.log(`  ↩ F#${f.id}: ${f.text}`);
        console.log(
          `    ${f.resolved_at ? `resuelto: ${f.response ?? "(sin resumen)"}` : "(PENDIENTE — trabajalo)"}`
        );
      }
    });
  },

  // The loop can append its own task (created_by = loop).
  "add-task"(db, { flags }) {
    const project = resolveProject(db, flags.project);
    const docu = resolveDocument(db, project, flags.document);
    const title = flags.title;
    if (!title || title === true) fail("add-task requires --title");
    const info = db
      .prepare(
        "INSERT INTO task (document_id, title, body, created_by) VALUES (?, ?, ?, 'loop')"
      )
      .run(docu.id, title, flags.body && flags.body !== true ? flags.body : "");
    out(flags, { id: info.lastInsertRowid }, (x) => console.log(`created task #${x.id}`));
  },

  "update-task"(db, { pos, flags }) {
    const id = Number(pos[0]);
    if (!id) fail("update-task requires a task id");
    if (!db.prepare("SELECT 1 FROM task WHERE id = ?").get(id)) fail(`task not found: ${id}`);
    const sets = [];
    const vals = [];
    if (flags.status && flags.status !== true) {
      const s = String(flags.status);
      if (!["todo", "in_progress", "blocked", "done"].includes(s))
        fail(`invalid status: ${s}`);
      sets.push("status = ?");
      vals.push(s);
    }
    if (flags.stage && flags.stage !== true) {
      const s = String(flags.stage);
      if (!["local", "develop", "production"].includes(s)) fail(`invalid stage: ${s}`);
      sets.push("stage = ?");
      vals.push(s);
    }
    if (flags.title && flags.title !== true) {
      sets.push("title = ?");
      vals.push(String(flags.title));
    }
    if (flags.body !== undefined) {
      sets.push("body = ?");
      vals.push(flags.body === true ? "" : String(flags.body));
    }
    const summary = readSummary(flags);
    if (summary !== undefined) {
      sets.push("summary = ?");
      vals.push(summary);
    }
    if (sets.length === 0)
      fail("nothing to update (use --status/--stage/--title/--body/--summary)");
    // Claiming a task counts as activity.
    if (flags.status === "in_progress") sets.push("last_heartbeat = datetime('now')");
    // Cambiar de status invalida la nota "qué estoy haciendo ahora".
    if (flags.status && flags.status !== true) sets.push("heartbeat_note = NULL");
    db.prepare(`UPDATE task SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`).run(
      ...vals,
      id
    );
    out(flags, { ok: true, id }, () => console.log(`updated task #${id}`));
  },

  // Signal that you're actively working on a task right now. Call it
  // periodically during long work so the UI shows the task as "trabajando".
  // --note "corriendo suite e2e (~30 min)" deja visible en la UI qué estás
  // haciendo mientras no hay más señales; un heartbeat sin --note la limpia.
  heartbeat(db, { pos, flags }) {
    const id = Number(pos[0]);
    if (!id) fail("heartbeat requires a task id");
    if (!db.prepare("SELECT 1 FROM task WHERE id = ?").get(id)) fail(`task not found: ${id}`);
    const note = flags.note && flags.note !== true ? String(flags.note) : null;
    db.prepare(
      "UPDATE task SET last_heartbeat = datetime('now'), heartbeat_note = ?, status = CASE WHEN status = 'done' THEN status ELSE 'in_progress' END WHERE id = ?"
    ).run(note, id);
    out(flags, { ok: true, id }, () => console.log(`heartbeat task #${id}`));
  },

  // Mark a task done, optionally setting stage and a summary in one shot.
  // Summary: --summary "...", or (better for long markdown) --summary-file <p>.
  done(db, { pos, flags }) {
    const id = Number(pos[0]);
    if (!id) fail("done requires a task id");
    if (!db.prepare("SELECT 1 FROM task WHERE id = ?").get(id)) fail(`task not found: ${id}`);
    const sets = ["status = 'done'", "heartbeat_note = NULL"];
    const vals = [];
    if (flags.stage && flags.stage !== true) {
      const s = String(flags.stage);
      if (!["local", "develop", "production"].includes(s)) fail(`invalid stage: ${s}`);
      sets.push("stage = ?");
      vals.push(s);
    }
    const summary = readSummary(flags);
    // Si la task fue reabierta con follow-ups, el resumen responde el follow-up
    // (queda en el hilo) y el resumen original de la task se preserva.
    const openFollowups = db
      .prepare("SELECT id FROM followup WHERE task_id = ? AND resolved_at IS NULL")
      .all(id);
    let resolved = 0;
    if (openFollowups.length > 0) {
      resolved = db
        .prepare(
          "UPDATE followup SET response = ?, resolved_at = datetime('now') WHERE task_id = ? AND resolved_at IS NULL"
        )
        .run(summary ?? null, id).changes;
    } else if (summary !== undefined) {
      sets.push("summary = ?");
      vals.push(summary);
    }
    db.prepare(
      `UPDATE task SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`
    ).run(...vals, id);
    out(flags, { ok: true, id, followups_resolved: resolved }, () =>
      console.log(`done task #${id}${resolved ? ` (${resolved} follow-up resuelto)` : ""}`)
    );
  },

  // What git work has the human requested for this project? (cwd-scoped)
  "git-pending"(db, { flags }) {
    const project = resolveProject(db, flags.project);
    const tasks = db
      .prepare(
        `SELECT t.id, t.title, t.summary, t.status, t.stage, t.commit_hash
           FROM task t JOIN document d ON d.id = t.document_id
          WHERE d.project_id = ? AND t.commit_requested = 1
          ORDER BY t.id`
      )
      .all(project.id);
    const data = {
      project: project.name,
      path: project.path,
      target_branch: project.target_branch,
      push_stage: project.push_stage,
      push_requested: !!project.push_requested,
      tasks_to_commit: tasks,
    };
    out(flags, data, (x) => {
      console.log(
        `proyecto: ${x.project}  rama destino: ${x.target_branch}  push pedido: ${x.push_requested ? "SÍ" : "no"}`
      );
      if (x.tasks_to_commit.length) {
        console.log("tasks a commitear:");
        x.tasks_to_commit.forEach((t) => console.log(`  #${t.id}  ${t.title}`));
      } else {
        console.log("(sin tasks pendientes de commit)");
      }
    });
  },

  // The loop reports it committed a task. --hash <sha> records the commit.
  "mark-committed"(db, { pos, flags }) {
    const id = Number(pos[0]);
    if (!id) fail("mark-committed requires a task id");
    if (!db.prepare("SELECT 1 FROM task WHERE id = ?").get(id)) fail(`task not found: ${id}`);
    const hash = flags.hash && flags.hash !== true ? String(flags.hash) : null;
    db.prepare(
      "UPDATE task SET commit_requested = 0, commit_hash = ?, committed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
    ).run(hash, id);
    out(flags, { ok: true, id, hash }, () =>
      console.log(`task #${id} commiteada${hash ? ` (${hash})` : ""}`)
    );
  },

  // The loop reports the push result. --ok or --error "mensaje". (cwd-scoped)
  "mark-pushed"(db, { flags }) {
    const project = resolveProject(db, flags.project);
    const isError = flags.error && flags.error !== true;
    const status = isError ? `error: ${flags.error}` : "ok";
    db.prepare(
      "UPDATE project SET push_requested = 0, last_push_at = datetime('now'), push_status = ? WHERE id = ?"
    ).run(status, project.id);

    // On a successful push, the committed tasks now live on the pushed branch,
    // so bump their stage up to the project's push_stage (never downgrade).
    let bumped = 0;
    if (!isError) {
      const rank = { local: 0, develop: 1, production: 2 };
      const target = project.push_stage || "develop";
      const tr = rank[target] ?? 1;
      const tasks = db
        .prepare(
          `SELECT t.id, t.stage FROM task t JOIN document d ON d.id = t.document_id
            WHERE d.project_id = ? AND t.commit_hash IS NOT NULL`
        )
        .all(project.id);
      const upd = db.prepare(
        "UPDATE task SET stage = ?, updated_at = datetime('now') WHERE id = ?"
      );
      for (const t of tasks) {
        if ((rank[t.stage] ?? 0) < tr) {
          upd.run(target, t.id);
          bumped++;
        }
      }
    }
    out(flags, { ok: true, project: project.name, status, push_stage: project.push_stage, bumped }, () =>
      console.log(
        `push marcado (${status}) en ${project.name}` +
          (bumped ? ` · ${bumped} task(s) → ${project.push_stage}` : "")
      )
    );
  },

  // Ask the human a question about a task. Returns the question id.
  ask(db, { pos, flags }) {
    const id = Number(pos[0]);
    // Prefer --text-file / --text-stdin for long markdown questions (avoids
    // shell-escaping issues with backticks, quotes, URLs). Falls back to the
    // positional text or --text.
    let text;
    if (flags["text-file"] && flags["text-file"] !== true) {
      text = fs.readFileSync(String(flags["text-file"]), "utf8").trim();
    } else if (flags["text-stdin"]) {
      text = fs.readFileSync(0, "utf8").trim();
    } else {
      text = pos.slice(1).join(" ") || (flags.text && flags.text !== true ? String(flags.text) : "");
    }
    if (!id) fail("ask requires: taskapp ask <taskId> \"question\"");
    if (!text) fail("ask requires question text");
    if (!db.prepare("SELECT 1 FROM task WHERE id = ?").get(id)) fail(`task not found: ${id}`);
    const info = db
      .prepare("INSERT INTO question (task_id, text) VALUES (?, ?)")
      .run(id, text);
    // Optionally flag the task as blocked so it's visible in the UI.
    if (flags.block) {
      db.prepare("UPDATE task SET status = 'blocked', updated_at = datetime('now') WHERE id = ?").run(
        id
      );
    }
    out(flags, { id: info.lastInsertRowid }, (x) => console.log(`asked question #${x.id}`));
  },

  // List questions (default: scoped to project). Use --unanswered / --answered.
  questions(db, { flags }) {
    let rows;
    if (flags.task && flags.task !== true) {
      rows = db
        .prepare("SELECT * FROM question WHERE task_id = ? ORDER BY id")
        .all(Number(flags.task));
    } else {
      const project = resolveProject(db, flags.project);
      rows = db
        .prepare(
          `SELECT q.* FROM question q
             JOIN task t ON t.id = q.task_id
             JOIN document d ON d.id = t.document_id
            WHERE d.project_id = ? ORDER BY q.id`
        )
        .all(project.id);
    }
    if (flags.unanswered) rows = rows.filter((q) => !q.answered);
    if (flags.answered) rows = rows.filter((q) => q.answered);
    const attOf = db.prepare(
      "SELECT id, filename, path, mime FROM attachment WHERE question_id = ? ORDER BY id"
    );
    const data = rows.map((q) => ({
      ...q,
      answered: !!q.answered,
      // Adjuntos que el humano sumó al responder — abrilos con Read.
      attachments: attOf.all(q.id),
    }));
    out(flags, data, (r) =>
      r.length
        ? r.forEach((q) =>
            console.log(
              `Q#${q.id} (task ${q.task_id}) ${q.answered ? "✓" : "…"}  ${q.text}` +
                (q.answered ? `\n    A: ${q.answer}` : "") +
                q.attachments.map((a) => `\n    📎 ${a.path}`).join("")
            )
          )
        : console.log("(no questions)")
    );
  },
};

const HELP = `taskapp — coordina loops de Claude con la UI de TaskApp

DB: ${process.env.TASKAPP_DB || "~/.taskapp/taskapp.db"} (override con \$TASKAPP_DB)

ASOCIACIÓN POR DIRECTORIO: si omitís --project, el CLI resuelve el proyecto
cuyo "path" (cargado en la UI) coincide con el directorio actual (o un ancestro).
Corré el loop parado dentro del repo y no hace falta pasar --project.

  taskapp whoami                       → muestra a qué proyecto mapea este directorio

Lectura (lo que el loop hace cada iteración):
  taskapp tasks [--document "<doc>"] [--status todo,in_progress] [--json]
  taskapp show <taskId> [--json]
  taskapp questions [--answered|--unanswered] [--json]
  taskapp questions --task <taskId> [--json]

Escritura (lo que el loop reporta):
  taskapp update-task <taskId> [--status todo|in_progress|blocked|done] [--stage local|develop|production]
  taskapp heartbeat <taskId> [--note "corriendo suite e2e (~30 min)"]
       → "sigo trabajando en esta task" (llamalo cada tanto). La --note queda
         visible en la UI mientras dura un comando largo; un heartbeat sin
         --note la limpia.
  taskapp done <taskId> [--stage develop] --summary-file <ruta>
       → marca la task hecha + deja un resumen de lo que se hizo (OBLIGATORIO).
         Resumen: --summary "..."  |  --summary-file <ruta>  |  --summary-stdin
         Para markdown largo (con backticks/comillas) usá --summary-file.
         Si la task tenía follow-ups pendientes (el humano pidió más cosas sobre
         una task ya hecha), el resumen los responde y queda en el hilo.
  taskapp ask <taskId> "pregunta para el humano" [--block] [--json]
       Pregunta en MARKDOWN (saltos de línea, listas, **negrita**). Para
       preguntas largas/con backticks/URLs usá --text-file <ruta> (o --text-stdin).
  taskapp add-task [--document "<doc>"] --title "..." [--body "..."]

Git (lo PIDE el humano desde la app; lo EJECUTA el loop — ver la skill):
  taskapp git-pending [--json]         → tasks marcadas para commit + si hay push pedido + rama destino
  taskapp mark-committed <taskId> --hash <sha>   → reportá que commiteaste esa task
  taskapp mark-pushed [--error "msg"]  → reportá el resultado del push (sin --error = ok)

Pasá --project "<nombre>" en cualquier comando para forzar un proyecto puntual.

Setup / idempotente:
  taskapp ensure-project --name "<nombre>" [--path "<path>"]
  taskapp ensure-document --name "<doc>"
  taskapp projects
  taskapp db-path

Agregá --json a cualquier comando de lectura para salida parseable.`;

// --- main -----------------------------------------------------------------
const [, , cmd, ...rest] = process.argv;
if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  console.log(HELP);
  process.exit(0);
}
const handler = commands[cmd];
if (!handler) {
  console.error(`error: unknown command "${cmd}"\n`);
  console.log(HELP);
  process.exit(1);
}
const db = openDb();
try {
  handler(db, parseArgs(rest));
} finally {
  db.close();
}
