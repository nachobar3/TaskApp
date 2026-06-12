import { NextResponse } from "next/server";
import fs from "node:fs";
import { getAttachment, deleteAttachment } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const a = getAttachment(Number(id));
  if (!a || !fs.existsSync(a.path)) {
    return new NextResponse("not found", { status: 404 });
  }
  const buf = fs.readFileSync(a.path);
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": a.mime,
      "Content-Disposition": `inline; filename="${encodeURIComponent(a.filename)}"`,
      "Cache-Control": "no-store",
    },
  });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const a = getAttachment(Number(id));
  if (a) {
    try {
      fs.rmSync(a.path, { force: true });
    } catch {
      // ignore fs errors; still drop the row
    }
    deleteAttachment(a.id);
  }
  return NextResponse.json({ ok: true });
}
