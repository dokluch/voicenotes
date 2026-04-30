import { db } from "./db";
import { transcribeAudio, cleanAndSummarize } from "./transcribe";

export type ProcessEvent =
  | { type: "status"; status: "transcribing" | "cleaning" | "done" }
  | { type: "verbatim"; text: string }
  | { type: "done"; note: unknown }
  | { type: "error"; message: string };

interface NoteRow {
  id: string;
  created_at: number;
  audio_path: string | null;
  audio_mime: string | null;
  duration_ms: number | null;
}

/**
 * Run the transcribe → clean pipeline against the audio stored on disk for
 * the given note id, persist results to `notes`, and emit progress via `send`.
 *
 * Used by both the initial upload and the reprocess endpoint.
 */
export async function runProcessing(
  noteId: string,
  buffer: Buffer,
  mime: string,
  send: (e: ProcessEvent) => void,
  options: { logToLedger: boolean },
): Promise<void> {
  send({ type: "status", status: "transcribing" });

  try {
    const { text: verbatim, usage: transcribeUsage } = await transcribeAudio(
      buffer,
      mime,
    );
    db.prepare(
      `UPDATE notes SET verbatim = ?, error = NULL, status = 'cleaning' WHERE id = ?`,
    ).run(verbatim, noteId);
    send({ type: "verbatim", text: verbatim });
    send({ type: "status", status: "cleaning" });

    const {
      title,
      cleaned,
      summary,
      usage: cleanupUsage,
    } = await cleanAndSummarize(verbatim);

    const totalPromptTokens =
      transcribeUsage.prompt_tokens + cleanupUsage.prompt_tokens;
    const totalCompletionTokens =
      transcribeUsage.completion_tokens + cleanupUsage.completion_tokens;

    db.prepare(
      `UPDATE notes SET
         title = ?, cleaned = ?, summary = ?,
         transcribe_cost_usd = ?, cleanup_cost_usd = ?,
         prompt_tokens = ?, completion_tokens = ?,
         status = 'done', error = NULL
       WHERE id = ?`,
    ).run(
      title,
      cleaned,
      summary,
      transcribeUsage.cost,
      cleanupUsage.cost,
      totalPromptTokens,
      totalCompletionTokens,
      noteId,
    );

    if (options.logToLedger) {
      const row = db
        .prepare(`SELECT created_at, duration_ms FROM notes WHERE id = ?`)
        .get(noteId) as Pick<NoteRow, "created_at" | "duration_ms"> | undefined;
      db.prepare(
        `INSERT OR IGNORE INTO ledger
           (id, note_id, created_at, duration_ms,
            transcribe_cost_usd, cleanup_cost_usd, prompt_tokens, completion_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        noteId,
        noteId,
        row?.created_at ?? Date.now(),
        row?.duration_ms ?? 0,
        transcribeUsage.cost,
        cleanupUsage.cost,
        totalPromptTokens,
        totalCompletionTokens,
      );
    } else {
      // Reprocess: append a new ledger row keyed by a fresh id so totals reflect
      // the additional spend without overwriting the original entry.
      const ledgerId = `${noteId}-${Date.now()}`;
      db.prepare(
        `INSERT INTO ledger
           (id, note_id, created_at, duration_ms,
            transcribe_cost_usd, cleanup_cost_usd, prompt_tokens, completion_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        ledgerId,
        noteId,
        Date.now(),
        0, // don't double-count duration on reprocess
        transcribeUsage.cost,
        cleanupUsage.cost,
        totalPromptTokens,
        totalCompletionTokens,
      );
    }

    const note = db.prepare(`SELECT * FROM notes WHERE id = ?`).get(noteId);
    send({ type: "done", note });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db.prepare(`UPDATE notes SET status = 'error', error = ? WHERE id = ?`).run(
      msg,
      noteId,
    );
    send({ type: "error", message: msg });
  }
}
