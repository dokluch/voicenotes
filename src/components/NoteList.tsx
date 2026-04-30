"use client";

import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";

export interface Note {
  id: string;
  created_at: number;
  mic_label: string | null;
  audio_mime: string | null;
  duration_ms: number | null;
  verbatim: string | null;
  cleaned: string | null;
  title: string | null;
  summary: string | null;
  status: "transcribing" | "cleaning" | "done" | "error";
  error: string | null;
  transcribe_cost_usd: number | null;
  cleanup_cost_usd: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  audio_path: string | null;
  audio_size: number | null;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      onClick={copy}
      className="px-2 py-0.5 text-xs rounded border border-neutral-200 dark:border-neutral-700
                 hover:bg-neutral-100 dark:hover:bg-neutral-800 dark:text-neutral-300
                 transition-colors shrink-0"
    >
      {copied ? "Copied!" : label}
    </button>
  );
}

function formatDuration(ms: number) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function NoteCard({
  note,
  onDelete,
  onReprocess,
}: {
  note: Note;
  onDelete: (id: string) => void;
  onReprocess: (id: string) => void;
}) {
  const [showVerbatim, setShowVerbatim] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleDeleteClick = () => {
    if (!confirming) {
      setConfirming(true);
      confirmTimerRef.current = setTimeout(() => setConfirming(false), 4000);
    } else {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      onDelete(note.id);
    }
  };

  // Clear timer on unmount
  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    };
  }, []);
  const date = new Date(note.created_at);
  const dateStr = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const timeStr = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });

  const isPending =
    note.status === "transcribing" || note.status === "cleaning";

  return (
    <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-4 flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="font-medium text-sm truncate">
            {note.title ?? (isPending ? "Processing…" : "Untitled")}
          </p>
          <p className="text-xs text-neutral-400 mt-0.5">
            {dateStr} · {timeStr}
            {note.duration_ms ? ` · ${formatDuration(note.duration_ms)}` : ""}
            {note.mic_label ? ` · ${note.mic_label}` : ""}
            {(note.transcribe_cost_usd ?? 0) + (note.cleanup_cost_usd ?? 0) >
              0 &&
              ` · $${((note.transcribe_cost_usd ?? 0) + (note.cleanup_cost_usd ?? 0)).toFixed(4)}`}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isPending && (
            <span className="text-xs text-neutral-400 animate-pulse">
              {note.status === "transcribing" ? "Transcribing…" : "Cleaning…"}
            </span>
          )}
          {note.status === "error" && (
            <span className="text-xs text-red-500">Error</span>
          )}
          {note.cleaned && <CopyButton text={note.cleaned} label="Copy text" />}
          {note.summary && (
            <CopyButton text={note.summary} label="Copy summary" />
          )}
          {note.audio_path && (
            <a
              href={`/api/notes/${note.id}/audio`}
              download
              className="px-2 py-0.5 text-xs rounded border border-neutral-200 dark:border-neutral-700
                         hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors shrink-0
                         text-neutral-600 dark:text-neutral-400"
              title={`Download original audio${note.audio_size ? ` (${formatBytes(note.audio_size)})` : ""}`}
            >
              Audio
            </a>
          )}
          {note.audio_path && !isPending && (
            <button
              onClick={() => onReprocess(note.id)}
              className="px-2 py-0.5 text-xs rounded border border-neutral-200 dark:border-neutral-700
                         hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors shrink-0
                         text-neutral-600 dark:text-neutral-400"
              title="Re-run transcription and cleanup on the saved audio"
            >
              Reprocess
            </button>
          )}
          <button
            onClick={handleDeleteClick}
            aria-label={confirming ? "Confirm delete" : "Delete note"}
            className={`px-2 py-0.5 text-xs rounded border transition-colors
              ${
                confirming
                  ? "border-red-300 dark:border-red-800 text-red-500 bg-red-50 dark:bg-red-950 hover:bg-red-100 dark:hover:bg-red-900"
                  : "border-neutral-200 dark:border-neutral-700 text-neutral-400 hover:text-red-500 hover:border-red-200 dark:hover:border-red-700"
              }`}
          >
            {confirming ? "Confirm delete?" : "Delete"}
          </button>
        </div>
      </div>

      {/* Error */}
      {note.status === "error" && note.error && (
        <p className="text-xs text-red-500 bg-red-50 dark:bg-red-950/50 rounded p-2">
          {note.error}
        </p>
      )}

      {/* Summary */}
      {note.summary && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400 italic border-l-2 border-neutral-200 dark:border-neutral-700 pl-2">
          {note.summary}
        </p>
      )}

      {/* Cleaned text rendered as markdown */}
      {note.cleaned && (
        <div className="prose prose-sm prose-neutral dark:prose-invert max-w-none
                        prose-p:leading-relaxed prose-p:my-1.5
                        prose-ul:my-1.5 prose-ol:my-1.5
                        prose-li:my-0.5
                        prose-strong:font-semibold prose-strong:text-neutral-900 dark:prose-strong:text-neutral-100">
          <Markdown>{note.cleaned}</Markdown>
        </div>
      )}

      {/* Verbatim toggle */}
      {note.verbatim && (
        <div>
          <button
            onClick={() => setShowVerbatim((v) => !v)}
            className="text-xs text-neutral-400 hover:text-neutral-600 transition-colors"
          >
            {showVerbatim ? "Hide verbatim ▲" : "Show verbatim ▼"}
          </button>
          {showVerbatim && (
            <div className="mt-2 text-xs text-neutral-400 dark:text-neutral-500 whitespace-pre-wrap font-mono bg-neutral-50 dark:bg-neutral-800 rounded p-2 leading-relaxed">
              {note.verbatim}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface NoteListProps {
  notes: Note[];
  pendingId: string | null;
  onDelete: (id: string) => void;
  onReprocess: (id: string) => void;
}

export function NoteList({
  notes,
  pendingId,
  onDelete,
  onReprocess,
}: NoteListProps) {
  if (notes.length === 0 && !pendingId) {
    return (
      <p className="text-sm text-neutral-400 text-center py-12">
        No notes yet. Hit the button above to record your first one.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Optimistic pending row */}
      {pendingId && !notes.find((n) => n.id === pendingId) && (
        <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-4">
          <p className="text-sm text-neutral-400 animate-pulse">
            Uploading and transcribing…
          </p>
        </div>
      )}
      {notes.map((note) => (
        <NoteCard
          key={note.id}
          note={note}
          onDelete={onDelete}
          onReprocess={onReprocess}
        />
      ))}
    </div>
  );
}
