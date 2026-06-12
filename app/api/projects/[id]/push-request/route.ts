import { NextRequest, NextResponse } from "next/server";
import { setPushRequested } from "@/lib/db";
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
  setPushRequested(Number(id), requested);
  const worker = requested ? maybeStartWorker(Number(id)) : undefined;
  return NextResponse.json({ ok: true, worker });
}
