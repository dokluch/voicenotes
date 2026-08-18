"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type LiveStatus = "idle" | "loading" | "ready" | "listening" | "error";

interface LoadingProgress {
  file?: string;
  progress?: number; // 0..100
  status?: string;
}

interface FileTranscriptionProgress {
  currentChunk: number;
  totalChunks: number;
}

interface UseLiveTranscriptionOptions {
  /** Re-run whisper on the rolling buffer every N ms while listening. */
  tickMs?: number;
  /** Maximum window size in seconds before committing & sliding. */
  windowSeconds?: number;
  /** Overlap kept after committing a window, for context continuity. */
  overlapSeconds?: number;
  /** BCP-47 language code (e.g. "en"). Omit for auto-detect on multilingual models. */
  language?: string;
  /** HF model id (defaults to multilingual onnx-community/whisper-base). */
  model?: string;
}

const SAMPLE_RATE = 16000;
const FILE_CHUNK_SECONDS = 25;

/**
 * In-browser live transcription using transformers.js + Whisper in a Web Worker.
 *
 * Captures PCM from a MediaStream (must be a mic stream — we tap it without
 * stopping its tracks so the caller can keep using it for MediaRecorder), feeds
 * a rolling buffer to the worker every `tickMs`, and exposes incremental text.
 */
export function useLiveTranscription(opts: UseLiveTranscriptionOptions = {}) {
  const {
    tickMs = 3000,
    windowSeconds = 25,
    overlapSeconds = 4,
    language,
    model,
  } = opts;

  const [status, setStatus] = useState<LiveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<LoadingProgress | null>(null);
  const [fileProgress, setFileProgress] =
    useState<FileTranscriptionProgress | null>(null);
  // `committed` is finalized text from past windows; `partial` is the latest
  // re-transcription of the current window. Display = committed + " " + partial.
  const [committed, setCommitted] = useState("");
  const [partial, setPartial] = useState("");

  const workerRef = useRef<Worker | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const bufferRef = useRef<Float32Array[]>([]);
  const bufferSamplesRef = useRef(0);
  const tickTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reqIdRef = useRef(0);
  const lastReqIdRef = useRef(0);

  const transcribePcm = useCallback(
    (worker: Worker, audio: Float32Array): Promise<string> => {
      const id = ++reqIdRef.current;
      return new Promise((resolve, reject) => {
        const onMsg = (e: MessageEvent<Record<string, unknown>>) => {
          const msg = e.data;
          if (msg.type === "partial" && (msg.id as number) === id) {
            worker.removeEventListener("message", onMsg);
            resolve(((msg.text as string) || "").trim());
          } else if (msg.type === "error" && (msg.id as number) === id) {
            worker.removeEventListener("message", onMsg);
            reject(new Error((msg.message as string) || "Whisper failed"));
          }
        };
        worker.addEventListener("message", onMsg);
        worker.postMessage({ type: "transcribe", id, audio, language }, [
          audio.buffer,
        ]);
      });
    },
    [language],
  );

  const decodeBlobToMono16k = useCallback(async (blob: Blob) => {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const sourceContext = new Ctx();
    try {
      const buffer = await sourceContext.decodeAudioData(
        await blob.arrayBuffer(),
      );
      const frameCount = Math.ceil(buffer.duration * SAMPLE_RATE);
      const offlineContext = new OfflineAudioContext(
        1,
        frameCount,
        SAMPLE_RATE,
      );
      const source = offlineContext.createBufferSource();
      source.buffer = buffer;
      source.connect(offlineContext.destination);
      source.start(0);
      const rendered = await offlineContext.startRendering();
      const pcm = new Float32Array(rendered.length);
      rendered.copyFromChannel(pcm, 0);
      return pcm;
    } finally {
      await sourceContext.close().catch(() => undefined);
    }
  }, []);

  // Lazily create the worker on mount and kick off model load.
  const ensureWorker = useCallback((): Worker => {
    if (workerRef.current) return workerRef.current;

    const worker = new Worker(
      new URL("../workers/whisper-worker.ts", import.meta.url),
      { type: "module" },
    );

    worker.addEventListener(
      "message",
      (e: MessageEvent<Record<string, unknown>>) => {
        const msg = e.data;
        if (msg.type === "ready") {
          setStatus((s) => (s === "loading" ? "ready" : s));
          setProgress(null);
          return;
        }
        if (msg.type === "loading") {
          setProgress({
            file: msg.file as string | undefined,
            progress: msg.progress as number | undefined,
            status: msg.status as string | undefined,
          });
          return;
        }
        if (msg.type === "partial") {
          // Discard out-of-order responses (a newer tick already started).
          if ((msg.id as number) < lastReqIdRef.current) return;
          lastReqIdRef.current = msg.id as number;
          setPartial((msg.text as string) || "");
          return;
        }
        if (msg.type === "error") {
          setError((msg.message as string) || "Whisper worker error");
          setStatus("error");
          return;
        }
      },
    );

    worker.addEventListener("error", (e) => {
      setError(e.message || "Worker crashed");
      setStatus("error");
    });

    workerRef.current = worker;
    setStatus("loading");
    worker.postMessage({ type: "load", model });
    return worker;
  }, [model]);

  /** Pre-load the model without recording. Safe to call multiple times. */
  const preload = useCallback(() => {
    ensureWorker();
  }, [ensureWorker]);

  const transcribeBlob = useCallback(
    async (blob: Blob): Promise<string> => {
      setError(null);
      setFileProgress({ currentChunk: 0, totalChunks: 0 });
      const worker = ensureWorker();
      const pcm = await decodeBlobToMono16k(blob);
      const chunkSamples = FILE_CHUNK_SECONDS * SAMPLE_RATE;
      const totalChunks = Math.max(1, Math.ceil(pcm.length / chunkSamples));
      const chunks: string[] = [];

      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
        setFileProgress({
          currentChunk: chunkIndex + 1,
          totalChunks,
        });
        const start = chunkIndex * chunkSamples;
        const end = Math.min(start + chunkSamples, pcm.length);
        const chunk = pcm.slice(start, end);
        const text = await transcribePcm(worker, chunk);
        if (text) chunks.push(text);
      }

      setFileProgress(null);
      return chunks.join("\n\n").trim();
    },
    [decodeBlobToMono16k, ensureWorker, transcribePcm],
  );

  /** Concatenate buffered chunks into one Float32Array. */
  const snapshotBuffer = useCallback((): Float32Array => {
    const total = bufferSamplesRef.current;
    const out = new Float32Array(total);
    let offset = 0;
    for (const chunk of bufferRef.current) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }, []);

  /** Trim buffer to the trailing `keepSeconds` of audio. */
  const trimBufferTo = useCallback(
    (keepSeconds: number) => {
      const keep = Math.floor(keepSeconds * SAMPLE_RATE);
      if (bufferSamplesRef.current <= keep) return;
      const merged = snapshotBuffer();
      const trimmed = merged.slice(merged.length - keep);
      bufferRef.current = [trimmed];
      bufferSamplesRef.current = trimmed.length;
    },
    [snapshotBuffer],
  );

  const start = useCallback(
    async (stream: MediaStream) => {
      setError(null);
      setCommitted("");
      setPartial("");
      bufferRef.current = [];
      bufferSamplesRef.current = 0;
      reqIdRef.current = 0;
      lastReqIdRef.current = 0;

      const worker = ensureWorker();

      // AudioContext at 16k → browser resamples for us.
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new Ctx({ sampleRate: SAMPLE_RATE });
      audioCtxRef.current = ctx;

      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;

      // ScriptProcessorNode is deprecated but widely supported and the simplest
      // path to raw PCM without shipping a separate AudioWorklet module.
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      processor.onaudioprocess = (ev) => {
        const input = ev.inputBuffer.getChannelData(0);
        // Copy — the underlying buffer is reused by the audio thread.
        bufferRef.current.push(new Float32Array(input));
        bufferSamplesRef.current += input.length;
      };
      source.connect(processor);
      // ScriptProcessor only fires while connected to a destination — but we
      // don't want to hear ourselves. Route through a muted gain node.
      const sink = ctx.createGain();
      sink.gain.value = 0;
      processor.connect(sink);
      sink.connect(ctx.destination);

      setStatus("listening");

      tickTimerRef.current = setInterval(() => {
        if (bufferSamplesRef.current < SAMPLE_RATE * 1) return; // need ≥1s
        // If the window is full, commit the partial as final text and slide.
        const seconds = bufferSamplesRef.current / SAMPLE_RATE;
        if (seconds > windowSeconds) {
          setCommitted((prev) => {
            const next = partial.trim();
            if (!next) return prev;
            return prev ? `${prev} ${next}` : next;
          });
          setPartial("");
          trimBufferTo(overlapSeconds);
        }
        const audio = snapshotBuffer();
        const id = ++reqIdRef.current;
        worker.postMessage(
          { type: "transcribe", id, audio, language },
          // Transferring detaches our local copy — fine, we discard `audio`.
          [audio.buffer],
        );
      }, tickMs);
    },
    [
      ensureWorker,
      language,
      overlapSeconds,
      partial,
      snapshotBuffer,
      tickMs,
      trimBufferTo,
      windowSeconds,
    ],
  );

  const stop = useCallback(async (): Promise<string> => {
    if (tickTimerRef.current) {
      clearInterval(tickTimerRef.current);
      tickTimerRef.current = null;
    }
    try {
      processorRef.current?.disconnect();
      sourceRef.current?.disconnect();
      await audioCtxRef.current?.close();
    } catch {
      // ignore teardown errors
    }
    processorRef.current = null;
    sourceRef.current = null;
    audioCtxRef.current = null;

    // Flush: run one final transcription on the remaining buffer.
    const worker = workerRef.current;
    let finalText = committed;
    if (worker && bufferSamplesRef.current >= SAMPLE_RATE * 0.3) {
      const audio = snapshotBuffer();
      const tail = (await transcribePcm(worker, audio).catch(() => "")).trim();
      if (tail) {
        finalText = committed ? `${committed} ${tail}` : tail;
        setCommitted(finalText);
        setPartial("");
      }
    }

    bufferRef.current = [];
    bufferSamplesRef.current = 0;
    setStatus((s) => (s === "error" ? s : "ready"));
    return finalText;
  }, [committed, snapshotBuffer, transcribePcm]);

  // Tear down the worker when the consumer unmounts.
  useEffect(() => {
    return () => {
      try {
        workerRef.current?.postMessage({ type: "dispose" });
        workerRef.current?.terminate();
      } catch {
        // ignore
      }
      workerRef.current = null;
    };
  }, []);

  const text = (committed + " " + partial).trim();

  return {
    status,
    error,
    progress,
    fileProgress,
    text,
    committed,
    partial,
    start,
    stop,
    preload,
    transcribeBlob,
  };
}
