const OPENROUTER_BASE = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "google/gemini-3.1-flash-lite-preview";

function getApiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");
  return key;
}

interface TextPart {
  type: "text";
  text: string;
}

interface AudioPart {
  type: "input_audio";
  input_audio: { data: string; format: string };
}

type ContentPart = TextPart | AudioPart;

interface Message {
  role: "user" | "assistant" | "system";
  content: string | ContentPart[];
}

export interface UsageInfo {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** Cost in USD (OpenRouter credits = USD). */
  cost: number;
}

export interface ChatResult {
  text: string;
  usage: UsageInfo;
}

export async function chatCompletion(
  messages: Message[],
  temperature = 0,
): Promise<ChatResult> {
  const res = await fetch(OPENROUTER_BASE, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, messages, temperature }),
  });

  const json = await res.json();
  if (!res.ok) {
    throw new Error(`OpenRouter error ${res.status}: ${JSON.stringify(json)}`);
  }

  const content = json?.choices?.[0]?.message?.content;
  let text: string;
  if (typeof content === "string") {
    text = content.trim();
  } else if (Array.isArray(content)) {
    text = content
      .map((p: { text?: string }) => p.text ?? "")
      .join("\n")
      .trim();
  } else {
    throw new Error("Unexpected response shape from OpenRouter");
  }

  const u = json?.usage ?? {};
  const usage: UsageInfo = {
    prompt_tokens: Number(u.prompt_tokens ?? 0),
    completion_tokens: Number(u.completion_tokens ?? 0),
    total_tokens: Number(u.total_tokens ?? 0),
    cost: Number(u.cost ?? 0),
  };

  return { text, usage };
}
