export const runtime = "nodejs";
export const maxDuration = 600; // up to 10 min for long recordings

import { nanoid } from "nanoid";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import "@/lib/schema"; // ensure table exists
import { saveAudio } from "@/lib/audio-storage";
import { runProcessing, type ProcessEvent } from "@/lib/process";

// GET /api/notes — return last 100 notes, newest first
export async function GET() {
  const notes = db
    .prepare(
      `SELECT id, created_at, mic_label, audio_mime, duration_ms,
              title, cleaned, summary, verbatim, status, error,
              transcribe_cost_usd, cleanup_cost_usd, prompt_tokens, completion_tokens,
              audio_path, audio_size
       FROM notes ORDER BY created_at DESC LIMIT 100`,
    )
    .all();
  return NextResponse.json(notes);
}

// POST /api/notes — accept multipart form, persist audio, transcribe, clean, store.
// Returns a text/event-stream of JSON events so the client gets live progress.
export async function POST(req: NextRequest) {
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const audioFile = formData.get("audio");
  if (!(audioFile instanceof Blob)) {
    return NextResponse.json({ error: "audio field missing" }, { status: 400 });
  }
  if (audioFile.size < 1000) {
    return NextResponse.json(
      { error: "Audio too short or empty" },
      { status: 400 },
    );
  }
  if (audioFile.size > 25 * 1024 * 1024) {
    return NextResponse.json(
      { error: "Audio file exceeds 25 MB limit" },
      { status: 400 },
    );
  }

  const micLabel = (formData.get("mic_label") as string | null) ?? null;
  const durationMs = formData.get("duration_ms")
    ? Number(formData.get("duration_ms"))
    : null;
  const mime = audioFile.type || "audio/webm";

  const id = nanoid();
  const createdAt = Date.now();

  // Persist the audio FIRST, before any LLM call. If transcription fails or
  // times out, the original recording is still on disk and reprocessable.
  const arrayBuffer = await audioFile.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const audioPath = saveAudio(id, mime, buffer);

  db.prepare(
    `INSERT INTO notes
       (id, created_at, mic_label, audio_mime, duration_ms,
        audio_path, audio_size, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'transcribing')`,
  ).run(id, createdAt, micLabel, mime, durationMs, audioPath, buffer.length);

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
        await runProcessing(id, buffer, mime, send, { logToLedger: true });
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
