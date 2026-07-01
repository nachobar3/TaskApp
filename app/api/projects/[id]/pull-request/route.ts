import { NextRequest, NextResponse } from "next/server";
import { setPullRequested } from "@/lib/db";
import { maybeStartWorker } from "@/lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Human asks the worker to sync with remote: fetch the target branch and
// integrate any local changes that need to reach it. Mirrors push-request.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const requested = body?.requested !== false; // default true
  setPullRequested(Number(id), requested);
  const worker = requested ? maybeStartWorker(Number(id)) : undefined;
  return NextResponse.json({ ok: true, worker });
}
