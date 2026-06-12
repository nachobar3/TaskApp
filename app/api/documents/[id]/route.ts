import { NextResponse } from "next/server";
import { deleteDocument } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  deleteDocument(Number(id));
  return NextResponse.json({ ok: true });
}
