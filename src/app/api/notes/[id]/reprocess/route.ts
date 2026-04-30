export const runtime = "nodejs";
export const maxDuration = 600;

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import "@/lib/schema";
import { audioFileExists, readAudio } from "@/lib/audio-storage";
import { runProcessing, type ProcessEvent } from "@/lib/process";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const row = db
    .prepare(`SELECT audio_path, audio_mime FROM notes WHERE id = ?`)
    .get(id) as { audio_path: string | null; audio_mime: string | null } | undefined;

  if (!row) {
    return NextResponse.json({ error: "Note not found" }, { status: 404 });
  }
  if (!audioFileExists(row.audio_path)) {
    return NextResponse.json(
      { error: "Original audio is no longer available on disk" },
      { status: 410 },
    );
  }

  const buffer = readAudio(row.audio_path!);
  const mime = row.audio_mime || "audio/webm";

  // Reset the row to a clean transcribing state so the UI shows progress
  db.prepare(
    `UPDATE notes SET status = 'transcribing', error = NULL WHERE id = ?`,
  ).run(id);

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: ProcessEvent | { type: "id"; id: string }) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      };

      send({ type: "id", id });

      try {
        await runProcessing(id, buffer, mime, send, { logToLedger: false });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
