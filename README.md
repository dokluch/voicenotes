# voicenotes

A tiny, local-first web app for capturing voice memos in the browser, transcribing them, and turning them into clean, titled, summarized notes — all stored in a local SQLite file.

Built with Next.js 16 (App Router), React 19, TypeScript, Tailwind v4, and `better-sqlite3`. Transcription and cleanup both run through [OpenRouter](https://openrouter.ai) using a single multimodal model.

## Features

- One-click recording from any input device (mic picker remembers your choice).
- Streaming pipeline with live status updates over Server-Sent Events:
  `transcribing → cleaning → done`.
- Each note stores: verbatim transcript, cleaned version, generated title, short summary, duration, audio mime, and per-step token + cost.
- Audio files are persisted under `data/audio/` so notes can be re-processed later.
- Append-only `ledger` table tracks lifetime usage (notes count, total duration, total spend in USD) independent of deletes.
- Reprocess and delete actions per note.

## Project layout

```
src/
  app/
    page.tsx            # Recorder UI, note list, stats
    api/
      notes/            # GET/POST notes, GET/DELETE by id, POST reprocess
      stats/            # GET lifetime stats from the ledger
  components/
    Recorder.tsx        # MediaRecorder wrapper
    MicPicker.tsx       # Input device selector
    NoteList.tsx        # Rendered notes + actions
  lib/
    db.ts               # better-sqlite3 connection
    schema.ts           # Idempotent migrations (notes + ledger)
    transcribe.ts       # Transcribe + clean/summarize prompts
    openrouter.ts       # OpenRouter chat completions client
    process.ts          # Pipeline that writes to DB and emits SSE events
    audio-storage.ts    # Read/write audio blobs under data/audio/
data/                   # SQLite DB + audio (gitignored)
```

## Getting started

Requires Node 20+ and [pnpm](https://pnpm.io/).

```bash
pnpm install
cp .env.local.example .env.local   # if you keep an example file; otherwise create it
pnpm dev
```

Then open [http://localhost:3000](http://localhost:3000), grant mic permission, and hit record.

### Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `OPENROUTER_API_KEY` | yes | — | API key from openrouter.ai. |
| `DB_PATH` | no | `data/voicenotes.db` | Path to the SQLite database file. |

The default model is configured in [`src/lib/openrouter.ts`](src/lib/openrouter.ts).

## Scripts

```bash
pnpm dev      # next dev
pnpm build    # next build
pnpm start    # next start
pnpm lint     # eslint
```

## Data

All state lives on disk under `data/`:

- `data/voicenotes.db` — notes + ledger tables (auto-migrated on boot).
- `data/audio/` — original recordings, named by note id.

Both are gitignored. Delete the folder to fully reset.

## License

MIT

