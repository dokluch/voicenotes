import fs from "node:fs";
import path from "node:path";

const AUDIO_DIR = path.join(process.cwd(), "data", "audio");

function ensureDir() {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

const MIME_EXT: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
  "audio/aac": "aac",
};

export function extForMime(mime: string): string {
  const m = mime.split(";")[0].trim().toLowerCase();
  return MIME_EXT[m] ?? "webm";
}

/** Save audio to data/audio/<id>.<ext>, return the relative path stored in DB. */
export function saveAudio(id: string, mime: string, buffer: Buffer): string {
  ensureDir();
  const filename = `${id}.${extForMime(mime)}`;
  fs.writeFileSync(path.join(AUDIO_DIR, filename), buffer);
  return path.join("audio", filename);
}

export function readAudio(relPath: string): Buffer {
  const full = path.join(process.cwd(), "data", relPath);
  return fs.readFileSync(full);
}

export function audioFileExists(relPath: string | null | undefined): boolean {
  if (!relPath) return false;
  const full = path.join(process.cwd(), "data", relPath);
  return fs.existsSync(full);
}

export function deleteAudio(relPath: string | null | undefined): void {
  if (!relPath) return;
  const full = path.join(process.cwd(), "data", relPath);
  try {
    fs.unlinkSync(full);
  } catch {
    // file already gone — ignore
  }
}
