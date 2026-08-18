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

const ChunkCleanupSchema = z.object({
  cleaned: z.string(),
  summary: z.string(),
});

export type CleanupResult = z.infer<typeof CleanupSchema>;

export interface CleanupWithUsage extends CleanupResult {
  usage: UsageInfo;
}

function emptyUsage(): UsageInfo {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cost: 0,
  };
}

function addUsage(total: UsageInfo, next: UsageInfo): UsageInfo {
  return {
    prompt_tokens: total.prompt_tokens + next.prompt_tokens,
    completion_tokens: total.completion_tokens + next.completion_tokens,
    total_tokens: total.total_tokens + next.total_tokens,
    cost: total.cost + next.cost,
  };
}

function splitTranscript(text: string, maxChars = 7000): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (!current) {
      current = paragraph;
      continue;
    }
    if (current.length + paragraph.length + 2 <= maxChars) {
      current = `${current}\n\n${paragraph}`;
      continue;
    }
    chunks.push(current);
    current = paragraph;
  }
  if (current) chunks.push(current);

  return chunks.flatMap((chunk) => {
    if (chunk.length <= maxChars) return [chunk];
    const slices: string[] = [];
    for (let offset = 0; offset < chunk.length; offset += maxChars) {
      slices.push(chunk.slice(offset, offset + maxChars));
    }
    return slices;
  });
}

export async function cleanAndSummarize(
  verbatim: string,
): Promise<CleanupWithUsage> {
  const transcriptChunks = splitTranscript(verbatim);
  if (transcriptChunks.length > 1) {
    return cleanAndSummarizeChunked(transcriptChunks);
  }

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

async function cleanTranscriptChunk(
  chunk: string,
  chunkNumber: number,
  totalChunks: number,
): Promise<{ cleaned: string; summary: string; usage: UsageInfo }> {
  const { text: raw, usage } = await chatCompletion(
    [
      {
        role: "user",
        content: `You are editing chunk ${chunkNumber} of ${totalChunks} from one long verbatim voice transcript.

Return ONLY valid JSON matching this shape:
{"cleaned":"...","summary":"..."}

Rules:
- Preserve the speaker's original language. Do not translate.
- Preserve meaning exactly. Do not add or remove ideas.
- Remove filler words, repair punctuation, and format the cleaned text as Markdown.
- Use paragraph breaks where natural. Use lists only when the speaker is enumerating.
- The summary should be 1-2 plain-text sentences for this chunk only.

Transcript chunk:
${chunk}`,
      },
    ],
    0.2,
  );

  const jsonStr = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    const parsed = ChunkCleanupSchema.safeParse(JSON.parse(jsonStr));
    if (parsed.success) return { ...parsed.data, usage };
  } catch {
    // fall through to graceful degradation
  }

  return { cleaned: raw, summary: "", usage };
}

async function cleanAndSummarizeChunked(
  transcriptChunks: string[],
): Promise<CleanupWithUsage> {
  let usage = emptyUsage();
  const cleanedChunks: string[] = [];
  const summaries: string[] = [];

  for (
    let chunkIndex = 0;
    chunkIndex < transcriptChunks.length;
    chunkIndex += 1
  ) {
    const result = await cleanTranscriptChunk(
      transcriptChunks[chunkIndex],
      chunkIndex + 1,
      transcriptChunks.length,
    );
    cleanedChunks.push(result.cleaned);
    if (result.summary) summaries.push(`${chunkIndex + 1}. ${result.summary}`);
    usage = addUsage(usage, result.usage);
  }

  const cleaned = cleanedChunks.join("\n\n").trim();
  const excerpt = cleaned.slice(0, 5000);
  const { text: rawFinal, usage: finalUsage } = await chatCompletion(
    [
      {
        role: "user",
        content: `You are finalizing one long edited voice note from chunk summaries.

Return ONLY valid JSON matching this shape:
{"title":"...","summary":"..."}

Rules:
- Preserve the speaker's original language. Do not translate.
- title: 3-7 words, no punctuation at the end.
- summary: 1-3 plain-text sentences covering the whole recording.

Chunk summaries:
${summaries.join("\n")}

Opening excerpt for style/context:
${excerpt}`,
      },
    ],
    0.2,
  );

  usage = addUsage(usage, finalUsage);

  const jsonStr = rawFinal
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    const parsed = z
      .object({ title: z.string(), summary: z.string() })
      .safeParse(JSON.parse(jsonStr));
    if (parsed.success) {
      return { ...parsed.data, cleaned, usage };
    }
  } catch {
    // fall through to graceful degradation
  }

  return { title: "", cleaned, summary: summaries.join(" "), usage };
}
