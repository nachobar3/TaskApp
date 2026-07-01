import { NextRequest, NextResponse } from "next/server";
import {
  clearPushStatus,
  createTask,
  firstDocumentId,
  getProject,
} from "@/lib/db";
import { maybeStartWorker } from "@/lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Human answers an amber "necesita tu decisión" (push needs-confirm) banner.
// There's no task behind a project-level git prompt, so we turn the decision
// into a task carrying the original warning + the human's instruction, clear
// the banner, and relaunch a worker to act on it.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const projectId = Number(id);
  const { decision } = await req.json().catch(() => ({}));
  if (typeof decision !== "string" || !decision.trim()) {
    return NextResponse.json({ error: "decision is required" }, { status: 400 });
  }

  const project = getProject(projectId);
  if (!project) {
    return NextResponse.json({ error: "project not found" }, { status: 404 });
  }
  const documentId = firstDocumentId(projectId);
  if (!documentId) {
    return NextResponse.json(
      { error: "el proyecto no tiene documentos" },
      { status: 409 }
    );
  }

  // The amber banner text (sans the "confirm:" prefix) is the worker's question.
  const warning = project.push_status?.replace(/^confirm:\s*/, "").trim();
  const body = [
    "El humano respondió a un aviso de git/push que necesitaba su decisión (needs-confirm).",
    warning ? `\n**Aviso del worker:**\n${warning}` : "",
    `\n**Decisión del humano:**\n${decision.trim()}`,
  ]
    .filter(Boolean)
    .join("\n");

  const taskId = createTask(documentId, "Decisión sobre git/push", body, "user");
  // Banner answered → clear it so it doesn't stay pinned.
  clearPushStatus(projectId);
  // Same as the answered-question flow: relaunch under the project's rules
  // (respects auto_worker; the live-pid guard prevents double-spawn).
  const worker = maybeStartWorker(projectId);
  return NextResponse.json({ ok: true, task_id: taskId, worker });
}
