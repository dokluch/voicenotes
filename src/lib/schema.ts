import { db } from "./db";

/** Safely add a column to an existing table — no-op if it already exists. */
function addColumnIfMissing(table: string, column: string, decl: string) {
  const info = db.pragma(`table_info(${table})`) as { name: string }[];
  if (!info.some((col) => col.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

export function runMigrations() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id          TEXT PRIMARY KEY,
      created_at  INTEGER NOT NULL,
      mic_label   TEXT,
      audio_mime  TEXT,
      duration_ms INTEGER,
      verbatim    TEXT,
      cleaned     TEXT,
      title       TEXT,
      summary     TEXT,
      status      TEXT NOT NULL DEFAULT 'transcribing',
      error       TEXT
    )
  `);

  // Cost & token tracking — applied idempotently to both new and existing DBs
  addColumnIfMissing("notes", "transcribe_cost_usd", "REAL");
  addColumnIfMissing("notes", "cleanup_cost_usd", "REAL");
  addColumnIfMissing("notes", "prompt_tokens", "INTEGER");
  addColumnIfMissing("notes", "completion_tokens", "INTEGER");

  // Persisted audio file — relative path under data/audio/ + size in bytes
  addColumnIfMissing("notes", "audio_path", "TEXT");
  addColumnIfMissing("notes", "audio_size", "INTEGER");

  // Insert-only ledger — one row per completed note, never deleted.
  // Stats are computed from here so deleting a note never affects the tally.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ledger (
      id                  TEXT PRIMARY KEY,
      note_id             TEXT NOT NULL,
      created_at          INTEGER NOT NULL,
      duration_ms         INTEGER,
      transcribe_cost_usd REAL NOT NULL DEFAULT 0,
      cleanup_cost_usd    REAL NOT NULL DEFAULT 0,
      prompt_tokens       INTEGER NOT NULL DEFAULT 0,
      completion_tokens   INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Backfill ledger from pre-existing completed notes (INSERT OR IGNORE = idempotent)
  db.exec(`
    INSERT OR IGNORE INTO ledger
      (id, note_id, created_at, duration_ms,
       transcribe_cost_usd, cleanup_cost_usd, prompt_tokens, completion_tokens)
    SELECT
      id, id, created_at, duration_ms,
      COALESCE(transcribe_cost_usd, 0),
      COALESCE(cleanup_cost_usd, 0),
      COALESCE(prompt_tokens, 0),
      COALESCE(completion_tokens, 0)
    FROM notes
    WHERE status = 'done'
  `);
}

runMigrations();
