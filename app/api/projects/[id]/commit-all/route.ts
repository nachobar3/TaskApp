import { NextRequest, NextResponse } from "next/server";
import { requestCommitAllDone } from "@/lib/db";
import { maybeStartWorker } from "@/lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const projectId = Number(id);
  const flagged = requestCommitAllDone(projectId);
  // Only wake a worker if there's actually something to commit.
  const worker = flagged > 0 ? maybeStartWorker(projectId) : undefined;
  return NextResponse.json({ ok: true, flagged, worker });
}
