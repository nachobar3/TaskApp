import { NextRequest, NextResponse } from "next/server";
import {
  clearPullStatus,
  clearPushStatus,
  deleteProject,
  setAutoWorker,
  setPoweredOff,
  setPushDestination,
  setWorkerModel,
} from "@/lib/db";
import { isValidWorkerModel } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  // Select the active push destination: branch + stage move together (the user
  // picks one of the configured branch → stage pairs).
  if (
    typeof body?.target_branch === "string" &&
    body.target_branch.trim() &&
    (body?.push_stage === "develop" || body?.push_stage === "production")
  ) {
    setPushDestination(Number(id), body.target_branch.trim(), body.push_stage);
  }
  if (typeof body?.auto_worker === "boolean") {
    setAutoWorker(Number(id), body.auto_worker);
  }
  if (typeof body?.powered_off === "boolean") {
    setPoweredOff(Number(id), body.powered_off);
  }
  if (isValidWorkerModel(body?.worker_model)) {
    setWorkerModel(Number(id), body.worker_model);
  }
  // Dismiss the "último push" banner (e.g. a needs-confirm/error left pinned).
  if (body?.clear_push_status === true) {
    clearPushStatus(Number(id));
  }
  // Dismiss the "último sync" banner.
  if (body?.clear_pull_status === true) {
    clearPullStatus(Number(id));
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  deleteProject(Number(id));
  return NextResponse.json({ ok: true });
}
