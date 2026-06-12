import { NextRequest, NextResponse } from "next/server";
import { maybeStartWorker } from "@/lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Manual "Correr ahora": launches a worker even with auto_worker off. The
// only thing it never does is double-spawn (live pid guard in maybeStartWorker).
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = maybeStartWorker(Number(id), { manual: true });
  return NextResponse.json(
    result.started ? result : { ...result, error: result.reason },
    { status: result.started ? 200 : 409 }
  );
}
