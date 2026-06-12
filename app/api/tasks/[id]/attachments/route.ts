import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { attachmentsDir, createAttachment, taskExists } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const taskId = Number(id);
  if (!taskExists(taskId)) {
    return NextResponse.json({ error: "task not found" }, { status: 404 });
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!file || typeof file === "string") {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const dir = path.join(attachmentsDir(), String(taskId));
  fs.mkdirSync(dir, { recursive: true });

  const mime = file.type || "application/octet-stream";
  const fromName = file.name?.includes(".")
    ? file.name.split(".").pop()!.toLowerCase()
    : "";
  const ext =
    (fromName.replace(/[^a-z0-9]/g, "").slice(0, 6) || EXT_BY_MIME[mime] || "bin");
  const stored = `${crypto.randomUUID()}.${ext}`;
  const full = path.join(dir, stored);
  fs.writeFileSync(full, buf);

  const rec = createAttachment(taskId, file.name || stored, full, mime);
  return NextResponse.json({ id: rec.id, filename: rec.filename, mime: rec.mime });
}
