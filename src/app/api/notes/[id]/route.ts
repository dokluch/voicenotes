export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import "@/lib/schema";
import { deleteAudio } from "@/lib/audio-storage";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const row = db
    .prepare(`SELECT audio_path FROM notes WHERE id = ?`)
    .get(id) as { audio_path: string | null } | undefined;
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  db.prepare(`DELETE FROM notes WHERE id = ?`).run(id);
  deleteAudio(row.audio_path);
  return new NextResponse(null, { status: 204 });
}
