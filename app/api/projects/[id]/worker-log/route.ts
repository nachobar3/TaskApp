import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getProject, pidAlive } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Tail this much of the log — enough for recent activity, bounded so a huge
// stream-json log (tool results can be large) never blows up the response.
const TAIL_BYTES = 96 * 1024;
const MAX_EVENTS = 120;
const CLIP = 600; // truncate any single event's text

function logDir(): string {
  return path.join(
    path.dirname(process.env.TASKAPP_DB || path.join(os.homedir(), ".taskapp", "db")),
    "logs"
  );
}

interface Ev {
  kind: "text" | "tool" | "result" | "run" | "sep";
  text: string;
}

// Summarize a tool_use input into a short, human one-liner.
function toolLine(name: string, input: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v ?? ""));
  switch (name) {
    case "Bash":
      return `⚡ ${s(input.command).split("\n")[0]}`;
    case "Read":
      return `📖 leyó ${s(input.file_path)}`;
    case "Edit":
      return `✏️ editó ${s(input.file_path)}`;
    case "Write":
      return `📝 escribió ${s(input.file_path)}`;
    case "Grep":
      return `🔎 grep ${s(input.pattern)}`;
    case "Glob":
      return `🗂️ glob ${s(input.pattern)}`;
    case "Task":
      return `🤖 subagente: ${s(input.description)}`;
    default:
      return `🔧 ${name}`;
  }
}

function parse(raw: string): Ev[] {
  const out: Ev[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("===== worker")) {
      out.push({ kind: "sep", text: t.replace(/=+/g, "").trim() });
      continue;
    }
    if (!t.startsWith("{")) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(t);
    } catch {
      continue; // partial/truncated line (we tailed mid-file)
    }
    if (ev.type === "assistant") {
      const msg = ev.message as { content?: Array<Record<string, unknown>> };
      for (const c of msg?.content ?? []) {
        if (c.type === "text" && typeof c.text === "string" && c.text.trim()) {
          out.push({ kind: "text", text: (c.text as string).slice(0, CLIP) });
        } else if (c.type === "tool_use") {
          out.push({
            kind: "tool",
            text: toolLine(
              String(c.name),
              (c.input as Record<string, unknown>) ?? {}
            ).slice(0, CLIP),
          });
        }
      }
    } else if (ev.type === "result") {
      const r = typeof ev.result === "string" ? ev.result : ev.subtype;
      out.push({ kind: "result", text: String(r ?? "fin").slice(0, CLIP) });
    }
  }
  return out.slice(-MAX_EVENTS);
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const p = getProject(Number(id));
  if (!p) return NextResponse.json({ error: "not found" }, { status: 404 });

  const file = path.join(logDir(), `${p.id}-${p.name.replace(/[^\w.-]+/g, "_")}.log`);
  let raw = "";
  try {
    const fd = fs.openSync(file, "r");
    try {
      const { size } = fs.fstatSync(fd);
      const start = Math.max(0, size - TAIL_BYTES);
      const len = size - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      raw = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return NextResponse.json({ events: [], empty: true });
  }
  return NextResponse.json({ events: parse(raw), running: pidAlive(p.worker_pid) });
}
