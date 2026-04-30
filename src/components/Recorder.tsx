"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface RecorderProps {
  deviceId: string;
  micLabel: string;
  onRecordingDone: (blob: Blob, durationMs: number, micLabel: string) => void;
}

const PREFERRED_MIMES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg",
  "audio/mp4",
];

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

function getSupportedMime(): string {
  for (const mime of PREFERRED_MIMES) {
    if (
      typeof MediaRecorder !== "undefined" &&
      MediaRecorder.isTypeSupported(mime)
    ) {
      return mime;
    }
  }
  return "";
}

/** Best-effort: derive duration from a Blob via a hidden Audio element. */
function getAudioDuration(blob: Blob): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    const cleanup = () => URL.revokeObjectURL(url);
    audio.addEventListener("loadedmetadata", () => {
      cleanup();
      resolve(
        isFinite(audio.duration) ? Math.round(audio.duration * 1000) : null,
      );
    });
    audio.addEventListener("error", () => {
      cleanup();
      resolve(null);
    });
    setTimeout(() => {
      cleanup();
      resolve(null);
    }, 5000);
  });
}

export function Recorder({
  deviceId,
  micLabel,
  onRecordingDone,
}: RecorderProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [isDragOver, setIsDragOver] = useState(false);
  const [dragError, setDragError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragCountRef = useRef(0);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const stopRecording = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    mediaRecorderRef.current?.stop();
  }, []);

  const startRecording = useCallback(async () => {
    chunksRef.current = [];
    const constraints: MediaStreamConstraints = {
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    };

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      console.warn("Failed with exact deviceId, falling back", err);
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    streamRef.current = stream;

    const mime = getSupportedMime();
    const recorder = new MediaRecorder(
      stream,
      mime ? { mimeType: mime } : undefined,
    );
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.onstop = () => {
      const durationMs = Date.now() - startTimeRef.current;
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      const blob = new Blob(chunksRef.current, {
        type: recorder.mimeType || "audio/webm",
      });
      setIsRecording(false);
      setElapsedMs(0);
      onRecordingDone(blob, durationMs, micLabel);
    };

    recorder.start(100);
    startTimeRef.current = Date.now();
    setIsRecording(true);
    timerRef.current = setInterval(() => {
      setElapsedMs(Date.now() - startTimeRef.current);
    }, 200);
  }, [deviceId, micLabel, onRecordingDone]);

  // Spacebar push-to-talk — no eslint-disable needed
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" && e.target === document.body && !isRecording) {
        e.preventDefault();
        startRecording();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space" && isRecording) {
        e.preventDefault();
        stopRecording();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [isRecording, startRecording, stopRecording]);

  const handleFile = async (file: File) => {
    setDragError(null);
    if (!file.type.startsWith("audio/")) {
      setDragError("Only audio files are supported.");
      setTimeout(() => setDragError(null), 4000);
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setDragError("File too large (max 25 MB).");
      setTimeout(() => setDragError(null), 4000);
      return;
    }
    const blob = new Blob([await file.arrayBuffer()], {
      type: file.type || "audio/webm",
    });
    const durationMs = (await getAudioDuration(blob)) ?? 0;
    onRecordingDone(blob, durationMs, `Uploaded: ${file.name}`);
  };

  const toggle = () => {
    if (isRecording) stopRecording();
    else startRecording();
  };

  // Drag handlers — use a counter to correctly handle nested elements
  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragCountRef.current += 1;
    setIsDragOver(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragCountRef.current -= 1;
    if (dragCountRef.current === 0) setIsDragOver(false);
  };
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragCountRef.current = 0;
    setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const seconds = Math.floor(elapsedMs / 1000);
  const centis = String(Math.floor((elapsedMs % 1000) / 10)).padStart(2, "0");

  return (
    <div
      className="relative flex flex-col items-center gap-4 w-full"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {/* Drag overlay */}
      {isDragOver && (
        <div
          className="absolute inset-0 -m-6 rounded-xl border-2 border-dashed border-neutral-400 dark:border-neutral-500
                        bg-neutral-50/90 dark:bg-neutral-900/90 flex items-center justify-center z-10 pointer-events-none"
        >
          <p className="text-sm text-neutral-500 dark:text-neutral-400 font-medium">
            Drop audio file to transcribe
          </p>
        </div>
      )}

      <button
        onClick={toggle}
        aria-label={isRecording ? "Stop recording" : "Start recording"}
        className={`
          w-20 h-20 rounded-full flex items-center justify-center text-white text-2xl
          shadow-md transition-all duration-150 active:scale-95 focus:outline-none
          focus-visible:ring-4 focus-visible:ring-offset-2
          ${
            isRecording
              ? "bg-red-500 hover:bg-red-600 focus-visible:ring-red-300 animate-pulse"
              : "bg-neutral-800 hover:bg-neutral-700 focus-visible:ring-neutral-400"
          }
        `}
      >
        {isRecording ? "■" : "●"}
      </button>

      <div className="flex flex-col items-center gap-1 min-h-8">
        {isRecording ? (
          <span className="text-xs font-mono text-neutral-400">
            {seconds}:{centis}
          </span>
        ) : (
          <span className="text-xs text-neutral-400">
            Click or hold Space to record
          </span>
        )}
        {dragError && <span className="text-xs text-red-500">{dragError}</span>}
        {!isRecording && (
          <>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="text-xs text-neutral-400 hover:text-neutral-600 underline underline-offset-2 transition-colors"
            >
              or upload a file
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
                e.target.value = "";
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}
