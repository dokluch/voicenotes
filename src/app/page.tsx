"use client";

import { useCallback, useEffect, useState } from "react";
import { MicPicker } from "@/components/MicPicker";
import { Recorder } from "@/components/Recorder";
import { NoteList, type Note } from "@/components/NoteList";

const MIC_STORAGE_KEY = "voicenotes_mic_device_id";

interface Stats {
  note_count: number;
  total_duration_ms: number;
  total_cost_usd: number;
}

function formatTotalDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function extensionForMime(mime: string): string {
  const base = mime.split(";")[0].trim().toLowerCase();
  if (base === "audio/ogg") return "ogg";
  if (base === "audio/mp4") return "m4a";
  if (base === "audio/mpeg" || base === "audio/mp3") return "mp3";
  if (base === "audio/wav" || base === "audio/x-wav") return "wav";
  return "webm";
}

export default function HomePage() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [notes, setNotes] = useState<Note[]>([]);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);

  const fetchStats = useCallback(async () => {
    const res = await fetch("/api/stats");
    if (res.ok) setStats(await res.json());
  }, []);

  // Load notes on mount
  const fetchNotes = useCallback(async () => {
    const res = await fetch("/api/notes");
    if (res.ok) {
      const data = await res.json();
      setNotes(data);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchNotes();
      void fetchStats();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [fetchNotes, fetchStats]);

  // Enumerate microphones (need permission first)
  const enumerateDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter((d) => d.kind === "audioinput");
      setDevices(mics);

      const stored = localStorage.getItem(MIC_STORAGE_KEY);
      const match = stored && mics.find((m) => m.deviceId === stored);
      if (match) {
        setSelectedDeviceId(match.deviceId);
      } else if (mics.length > 0) {
        setSelectedDeviceId(mics[0].deviceId);
      }
    } catch {
      // Ignore — devices will be empty, recorder will use default
    }
  }, []);

  // Request mic permission once on mount so labels are populated
  useEffect(() => {
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        stream.getTracks().forEach((t) => t.stop());
        enumerateDevices();
      })
      .catch(() => {
        enumerateDevices();
      });
  }, [enumerateDevices]);

  const handleDeviceChange = (id: string) => {
    setSelectedDeviceId(id);
    localStorage.setItem(MIC_STORAGE_KEY, id);
  };

  const selectedLabel =
    devices.find((d) => d.deviceId === selectedDeviceId)?.label ??
    "Default mic";

  const handleRecordingDone = async (
    blob: Blob,
    durationMs: number,
    micLabel: string,
    liveTranscript?: string,
  ) => {
    if (blob.size < 1000) {
      console.error("Upload failed", {
        error: "Recording was too short or empty",
        size: blob.size,
        type: blob.type,
        durationMs,
      });
      return;
    }

    const form = new FormData();
    form.append("audio", blob, `recording.${extensionForMime(blob.type)}`);
    form.append("mic_label", micLabel);
    form.append("duration_ms", String(durationMs));
    if (liveTranscript?.trim()) {
      form.append("live_transcript", liveTranscript.trim());
    }

    // Show a placeholder until the server assigns a real ID
    const uploadId = `uploading-${Date.now()}`;
    setPendingId(uploadId);

    try {
      const res = await fetch("/api/notes", { method: "POST", body: form });
      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => "");
        let details: unknown = body;
        try {
          details = body ? JSON.parse(body) : null;
        } catch {
          // Keep raw response text.
        }
        console.error("Upload failed", {
          status: res.status,
          statusText: res.statusText,
          size: blob.size,
          type: blob.type,
          durationMs,
          details,
        });
        return;
      }

      await consumeNoteStream(res, {
        onId: (id) => {
          setPendingId(null);
          setNotes((prev) => [
            {
              id,
              created_at: Date.now(),
              mic_label: micLabel,
              audio_mime: blob.type || null,
              duration_ms: durationMs || null,
              status: "transcribing" as const,
              verbatim: null,
              cleaned: null,
              title: null,
              summary: null,
              error: null,
              transcribe_cost_usd: null,
              cleanup_cost_usd: null,
              prompt_tokens: null,
              completion_tokens: null,
              audio_path: null,
              audio_size: null,
            },
            ...prev,
          ]);
        },
      });
    } finally {
      setPendingId(null);
    }
  };

  const handleReprocess = async (id: string) => {
    // Mark the note as reprocessing in-place
    setNotes((prev) =>
      prev.map((n) =>
        n.id === id
          ? { ...n, status: "transcribing" as const, error: null }
          : n,
      ),
    );
    const res = await fetch(`/api/notes/${id}/reprocess`, { method: "POST" });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({ error: "Reprocess failed" }));
      console.error("Reprocess failed", err);
      setNotes((prev) =>
        prev.map((n) =>
          n.id === id
            ? {
                ...n,
                status: "error" as const,
                error: (err as { error?: string }).error ?? "Reprocess failed",
              }
            : n,
        ),
      );
      return;
    }
    await consumeNoteStream(res, {});
  };

  const handleDelete = async (id: string) => {
    await fetch(`/api/notes/${id}`, { method: "DELETE" });
    setNotes((prev) => prev.filter((n) => n.id !== id));
    fetchStats();
  };

  /**
   * Consume an SSE response from /api/notes (POST) or /api/notes/[id]/reprocess.
   * Updates the relevant note in-place as events arrive.
   */
  async function consumeNoteStream(
    res: Response,
    hooks: { onId?: (id: string) => void },
  ) {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let noteId: string | null = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop()!;

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(line.slice(6));
          } catch {
            continue;
          }

          if (ev.type === "id") {
            noteId = ev.id as string;
            hooks.onId?.(noteId);
          } else if (ev.type === "status" && noteId) {
            setNotes((prev) =>
              prev.map((n) =>
                n.id === noteId
                  ? { ...n, status: ev.status as Note["status"] }
                  : n,
              ),
            );
          } else if (ev.type === "verbatim" && noteId) {
            setNotes((prev) =>
              prev.map((n) =>
                n.id === noteId ? { ...n, verbatim: ev.text as string } : n,
              ),
            );
          } else if (ev.type === "done") {
            const finalNote = ev.note as Note;
            setNotes((prev) =>
              prev.map((n) => (n.id === noteId ? finalNote : n)),
            );
            await fetchStats();
          } else if (ev.type === "error" && noteId) {
            setNotes((prev) =>
              prev.map((n) =>
                n.id === noteId
                  ? {
                      ...n,
                      status: "error" as const,
                      error: ev.message as string,
                    }
                  : n,
              ),
            );
          }
        }
      }
    } finally {
      reader.cancel();
    }
  }

  return (
    <main className="max-w-2xl mx-auto w-full px-4 py-10 flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Voice Notes</h1>
        {stats && stats.note_count > 0 ? (
          <p className="text-sm text-neutral-400">
            {stats.note_count} {stats.note_count === 1 ? "note" : "notes"}
            {stats.total_duration_ms > 0 &&
              ` · ${formatTotalDuration(stats.total_duration_ms)} recorded`}
            {stats.total_cost_usd > 0 &&
              ` · $${stats.total_cost_usd.toFixed(4)} spent`}
          </p>
        ) : (
          <p className="text-sm text-neutral-400">
            Record → transcribe → clean → copy
          </p>
        )}
      </div>

      <div className="flex flex-col items-center gap-5 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-xl p-6">
        <MicPicker
          devices={devices}
          selectedId={selectedDeviceId}
          onChange={handleDeviceChange}
        />
        <Recorder
          deviceId={selectedDeviceId}
          micLabel={selectedLabel}
          onRecordingDone={handleRecordingDone}
        />
      </div>

      <NoteList
        notes={notes}
        pendingId={pendingId}
        onDelete={handleDelete}
        onReprocess={handleReprocess}
      />
    </main>
  );
}
