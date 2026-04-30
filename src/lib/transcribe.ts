import { z } from "zod";
import { chatCompletion, type UsageInfo } from "./openrouter";

// Map browser mime types to the format string the model expects
function mimeToFormat(mime: string): string {
  const m = mime.split(";")[0].trim().toLowerCase();
  const map: Record<string, string> = {
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
  return map[m] ?? "webm";
}

export interface TranscribeResult {
  text: string;
  usage: UsageInfo;
}

export async function transcribeAudio(
  buffer: Buffer,
  mime: string,
): Promise<TranscribeResult> {
  const format = mimeToFormat(mime);
  const audioB64 = buffer.toString("base64");

  const { text, usage } = await chatCompletion([
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "Transcribe this voice recording verbatim. Preserve language switches, punctuation, and natural breaks. Return only the transcript text — no preamble, no commentary.",
        },
        {
          type: "input_audio",
          input_audio: { data: audioB64, format },
        },
      ],
    },
  ]);
  return { text, usage };
}

const CleanupSchema = z.object({
  title: z.string(),
  cleaned: z.string(),
  summary: z.string(),
});

export type CleanupResult = z.infer<typeof CleanupSchema>;

export interface CleanupWithUsage extends CleanupResult {
  usage: UsageInfo;
}

export async function cleanAndSummarize(
  verbatim: string,
): Promise<CleanupWithUsage> {
  const { text: raw, usage } = await chatCompletion(
    [
      {
        role: "user",
        content: `You are an expert editor. Given the following verbatim voice transcript, produce three things:

1. **title**: A short (3–7 word) title capturing the main topic. No punctuation at the end.
2. **cleaned**: A clean, readable version of the transcript formatted as **Markdown**. Remove filler words (um, uh, like, you know), fix punctuation, and correct obvious misspellings. Use paragraph breaks where natural. Use bullet points or numbered lists if the speaker is enumerating items. Use **bold** for emphasis only when the speaker stresses something. Preserve the speaker's voice, vocabulary, and meaning exactly — do not add or remove ideas.
3. **summary**: A 1–3 sentence TL;DR of what was said. Plain text, no markdown.

Respond ONLY with valid JSON matching this shape (no markdown fences):
{"title":"...","cleaned":"...","summary":"..."}

Verbatim transcript:
${verbatim}`,
      },
    ],
    0.2,
  );

  // Strip markdown code fences if the model adds them, then parse
  const jsonStr = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    const parsed = CleanupSchema.safeParse(JSON.parse(jsonStr));
    if (parsed.success) return { ...parsed.data, usage };
  } catch {
    // fall through to graceful degradation
  }

  // Graceful fallback: treat raw text as cleaned, leave title/summary empty
  return { title: "", cleaned: raw, summary: "", usage };
}
