import { NextRequest, NextResponse } from "next/server";
import {
  clearPullStatus,
  createTask,
  firstDocumentId,
  getProject,
} from "@/lib/db";
import { maybeStartWorker } from "@/lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Human answers an amber "necesita tu decisión" (sync needs-confirm) banner:
// the worker hit a divergence it won't resolve blindly. We turn the decision
// into a task carrying the original warning + the human's instruction, clear
// the banner, and relaunch a worker to act on it. Mirrors push-decision.
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

  const warning = project.pull_status?.replace(/^confirm:\s*/, "").trim();
  const body = [
    "El humano respondió a un aviso de sync remoto que necesitaba su decisión (needs-confirm).",
    warning ? `\n**Aviso del worker:**\n${warning}` : "",
    `\n**Decisión del humano:**\n${decision.trim()}`,
  ]
    .filter(Boolean)
    .join("\n");

  const taskId = createTask(documentId, "Decisión sobre sync remoto", body, "user");
  clearPullStatus(projectId);
  const worker = maybeStartWorker(projectId);
  return NextResponse.json({ ok: true, task_id: taskId, worker });
}
