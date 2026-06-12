import { NextRequest, NextResponse } from "next/server";
import { projectIdForTask, setCommitRequested } from "@/lib/db";
import { maybeStartWorker } from "@/lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const requested = body?.requested !== false; // default true
  setCommitRequested(Number(id), requested);
  const projectId = requested ? projectIdForTask(Number(id)) : undefined;
  const worker = projectId ? maybeStartWorker(projectId) : undefined;
  return NextResponse.json({ ok: true, worker });
}
