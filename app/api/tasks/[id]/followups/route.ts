import { NextRequest, NextResponse } from "next/server";
import { createFollowup, projectIdForTask, taskExists } from "@/lib/db";
import { maybeStartWorker } from "@/lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const taskId = Number(id);
  if (!taskExists(taskId)) {
    return NextResponse.json({ error: "task not found" }, { status: 404 });
  }
  const { text } = await req.json();
  if (typeof text !== "string" || !text.trim()) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }
  const followupId = createFollowup(taskId, text.trim());
  const projectId = projectIdForTask(taskId);
  const worker = projectId ? maybeStartWorker(projectId) : undefined;
  return NextResponse.json({ id: followupId, worker });
}
