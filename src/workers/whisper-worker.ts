/// <reference lib="webworker" />
/**
 * Whisper inference worker. Lazily loads `@huggingface/transformers` and an ASR
 * pipeline, then transcribes Float32 PCM (16 kHz, mono) chunks sent from the
 * main thread.
 *
 * Messages in:
 *   { type: "load",  model?: string }
 *   { type: "transcribe", id: number, audio: Float32Array, language?: string }
 *   { type: "dispose" }
 *
 * Messages out:
 *   { type: "ready" }
 *   { type: "loading", status: "download"|"progress"|"done"|..., file?: string, progress?: number }
 *   { type: "partial", id: number, text: string }
 *   { type: "error",   id?: number, message: string }
 */

import {
  pipeline,
  env,
  type AutomaticSpeechRecognitionPipeline,
  type ProgressCallback,
} from "@huggingface/transformers";

// We always pull from the HF hub at runtime — there are no local model files.
env.allowLocalModels = false;
env.useBrowserCache = true;

let asr: AutomaticSpeechRecognitionPipeline | null = null;
let loadingPromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;
let currentModel = "";

const DEFAULT_MODEL = "onnx-community/whisper-base";

async function loadModel(
  model: string,
): Promise<AutomaticSpeechRecognitionPipeline> {
  if (asr && currentModel === model) return asr;
  if (loadingPromise && currentModel === model) return loadingPromise;

  currentModel = model;

  const onProgress: ProgressCallback = (data) => {
    self.postMessage({ type: "loading", ...data });
  };

  // Try WebGPU first (faster, ~5-10x), fall back to wasm.
  loadingPromise = (async () => {
    try {
      const p = (await pipeline("automatic-speech-recognition", model, {
        device: "webgpu",
        dtype: "fp32",
        progress_callback: onProgress,
      })) as AutomaticSpeechRecognitionPipeline;
      return p;
    } catch (err) {
      console.warn(
        "[whisper-worker] WebGPU unavailable, falling back to wasm",
        err,
      );
      const p = (await pipeline("automatic-speech-recognition", model, {
        device: "wasm",
        dtype: "q8",
        progress_callback: onProgress,
      })) as AutomaticSpeechRecognitionPipeline;
      return p;
    }
  })();

  asr = await loadingPromise;
  loadingPromise = null;
  self.postMessage({ type: "ready" });
  return asr;
}

self.addEventListener("message", async (e: MessageEvent) => {
  const msg = e.data as
    | { type: "load"; model?: string }
    | {
        type: "transcribe";
        id: number;
        audio: Float32Array;
        language?: string;
      }
    | { type: "dispose" };

  try {
    if (msg.type === "load") {
      await loadModel(msg.model ?? DEFAULT_MODEL);
      return;
    }

    if (msg.type === "transcribe") {
      const model = await loadModel(currentModel || DEFAULT_MODEL);
      const out = await model(msg.audio, {
        chunk_length_s: 30,
        stride_length_s: 5,
        task: "transcribe",
        language: msg.language,
        return_timestamps: false,
      });
      const text = Array.isArray(out)
        ? out.map((o) => ("text" in o ? o.text : "")).join(" ")
        : (out.text ?? "");
      self.postMessage({ type: "partial", id: msg.id, text: text.trim() });
      return;
    }

    if (msg.type === "dispose") {
      asr = null;
      loadingPromise = null;
      currentModel = "";
      return;
    }
  } catch (err) {
    self.postMessage({
      type: "error",
      id: (msg as { id?: number }).id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

export {};
