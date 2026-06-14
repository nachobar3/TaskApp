import { NextRequest, NextResponse } from "next/server";
import { addProjectBranch, deleteProjectBranch } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Add a branch → stage push destination to the project's catalog.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const branch = typeof body?.branch === "string" ? body.branch.trim() : "";
  const stage =
    body?.stage === "develop" || body?.stage === "production"
      ? body.stage
      : "production";
  if (!branch) {
    return NextResponse.json({ error: "branch required" }, { status: 400 });
  }
  addProjectBranch(Number(id), branch, stage);
  return NextResponse.json({ ok: true });
}

// Remove a destination by its id. Never leaves the project with zero.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const branchId = Number(body?.branch_id);
  if (!branchId) {
    return NextResponse.json({ error: "branch_id required" }, { status: 400 });
  }
  const removed = deleteProjectBranch(Number(id), branchId);
  if (!removed) {
    return NextResponse.json(
      { error: "no se puede borrar el último destino" },
      { status: 400 }
    );
  }
  return NextResponse.json({ ok: true });
}
