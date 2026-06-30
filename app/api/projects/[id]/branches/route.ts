import { NextRequest, NextResponse } from "next/server";
import {
  addProjectBranch,
  deleteProjectBranch,
  getProject,
  setBranchPromotion,
} from "@/lib/db";
import { listRemoteBranches } from "@/lib/git";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// List the project's REAL remote branches (connects to origin via git
// ls-remote) so the human picks a destination instead of typing it by hand.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = getProject(Number(id));
  if (!project) {
    return NextResponse.json({ error: "project not found" }, { status: 404 });
  }
  const result = await listRemoteBranches(project.path);
  return NextResponse.json(result);
}

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

// Update a destination's promotion process (how the worker delivers code to
// that branch): strategy (push|merge|pr) + source branch + free-form notes.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const branchId = Number(body?.branch_id);
  if (!branchId) {
    return NextResponse.json({ error: "branch_id required" }, { status: 400 });
  }
  const strategy =
    body?.promote_strategy === "merge" || body?.promote_strategy === "pr"
      ? body.promote_strategy
      : "push";
  const from =
    typeof body?.promote_from === "string" && body.promote_from.trim()
      ? body.promote_from.trim()
      : null;
  const notes =
    typeof body?.promote_notes === "string" && body.promote_notes.trim()
      ? body.promote_notes.trim()
      : null;
  setBranchPromotion(Number(id), branchId, strategy, from, notes);
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
