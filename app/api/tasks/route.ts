import { NextRequest, NextResponse } from "next/server";
import { createTask, projectIdForDocument } from "@/lib/db";
import { maybeStartWorker } from "@/lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { document_id, title, body } = await req.json();
  if (!document_id || !title) {
    return NextResponse.json(
      { error: "document_id and title are required" },
      { status: 400 }
    );
  }
  const id = createTask(Number(document_id), String(title).trim(), body ?? "");
  const projectId = projectIdForDocument(Number(document_id));
  const worker = projectId ? maybeStartWorker(projectId) : undefined;
  return NextResponse.json({ id, worker });
}
