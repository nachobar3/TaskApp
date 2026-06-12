import { NextRequest, NextResponse } from "next/server";
import { answerQuestion, projectIdForQuestion } from "@/lib/db";
import { maybeStartWorker } from "@/lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { answer } = await req.json();
  if (typeof answer !== "string" || !answer.trim()) {
    return NextResponse.json({ error: "answer is required" }, { status: 400 });
  }
  answerQuestion(Number(id), answer.trim());
  // An answered question usually means a worker exited blocked on it — relaunch.
  const projectId = projectIdForQuestion(Number(id));
  const worker = projectId ? maybeStartWorker(projectId) : undefined;
  return NextResponse.json({ ok: true, worker });
}
