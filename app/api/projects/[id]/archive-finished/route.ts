import { NextRequest, NextResponse } from "next/server";
import { archiveFinishedTasks } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const projectId = Number(id);
  const archived = archiveFinishedTasks(projectId);
  return NextResponse.json({ ok: true, archived });
}
