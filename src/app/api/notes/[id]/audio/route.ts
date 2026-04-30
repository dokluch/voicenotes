export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import "@/lib/schema";
import { audioFileExists, readAudio } from "@/lib/audio-storage";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const row = db
    .prepare(`SELECT audio_path, audio_mime FROM notes WHERE id = ?`)
    .get(id) as { audio_path: string | null; audio_mime: string | null } | undefined;
  if (!row || !audioFileExists(row.audio_path)) {
    return NextResponse.json({ error: "Audio not found" }, { status: 404 });
  }

  const buffer = readAudio(row.audio_path!);
  const mime = row.audio_mime || "audio/webm";
  const ext = row.audio_path!.split(".").pop() || "webm";

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": mime,
      "Content-Disposition": `attachment; filename="voicenote-${id}.${ext}"`,
      "Content-Length": String(buffer.length),
    },
  });
}
