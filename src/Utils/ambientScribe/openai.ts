/**
 * Thin OpenAI client used by the Ambient Scribe POC.
 *
 * SECURITY WARNING: Like the AssemblyAI client, this calls api.openai.com
 * directly from the browser using a key shipped in the bundle
 * (REACT_AI_VOICE_OPENAI_API_KEY). Acceptable for an experimental, opt-in
 * POC only. Route through the backend before production use.
 */
import { publishScribeDebug } from "@/Utils/ambientScribe/scribeDebugBus";

const REST_BASE = import.meta.env.DEV
  ? "/_openai/api"
  : "https://api.openai.com";

/** Public WS host (not proxied; CORS doesn't apply to WebSockets). */
export const OPENAI_REALTIME_WS_HOST = "api.openai.com";

/** Models we ship by default. Easy to override per-call if needed. */
export const OPENAI_REALTIME_MODEL = "gpt-4o-transcribe";
export const OPENAI_BATCH_DIARIZE_MODEL = "gpt-4o-transcribe-diarize";
export const OPENAI_EXTRACTION_MODEL = "gpt-4o-mini";
/**
 * Realtime conversation model used for unified live transcription + tool-call
 * extraction. Speaks PCM in, streams transcript events AND a forced
 * `update_form` function call whose JSON arguments fill the form live.
 */
export const OPENAI_REALTIME_CHAT_MODEL = "gpt-4o-realtime-preview-2024-12-17";

/** Sample rate the Realtime API expects in `pcm16` mode. */
export const OPENAI_SAMPLE_RATE = 24000;

/**
 * Tuned for clinical audio: clinicians pause mid-sentence to think or chart.
 * Defaults (500ms) fragment those into multiple turns.
 */
export const OPENAI_VAD_SILENCE_DURATION_MS = 1200;
export const OPENAI_VAD_PREFIX_PADDING_MS = 300;
export const OPENAI_VAD_THRESHOLD = 0.5;

interface OpenAIError {
  error?: { message?: string; type?: string; code?: string };
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as OpenAIError;
    const msg = data.error?.message || `OpenAI ${url} failed: ${res.status}`;
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

/**
 * Mint an ephemeral client_secret for a Realtime transcription session so the
 * browser WebSocket doesn't need to ship the long-lived API key.
 *
 * POST /v1/realtime/transcription_sessions
 * Returns a `client_secret` valid for the session lifetime.
 */
export async function getRealtimeTranscriptionToken(
  apiKey: string,
  config: {
    language?: string;
    prompt?: string;
  } = {},
): Promise<string> {
  const data = await fetchJson<{
    client_secret: { value: string; expires_at: number };
  }>(`${REST_BASE}/v1/realtime/transcription_sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input_audio_format: "pcm16",
      input_audio_transcription: {
        model: OPENAI_REALTIME_MODEL,
        ...(config.language ? { language: config.language } : {}),
        ...(config.prompt ? { prompt: config.prompt } : {}),
      },
      turn_detection: {
        type: "server_vad",
        threshold: OPENAI_VAD_THRESHOLD,
        prefix_padding_ms: OPENAI_VAD_PREFIX_PADDING_MS,
        silence_duration_ms: OPENAI_VAD_SILENCE_DURATION_MS,
      },
      input_audio_noise_reduction: { type: "near_field" },
    }),
  });
  return data.client_secret.value;
}

/* --------------------------- Batch transcription -------------------------- */

interface OpenAIDiarizedSegment {
  speaker?: string;
  text: string;
  start?: number;
  end?: number;
}

interface OpenAIDiarizedResponse {
  text?: string;
  segments?: OpenAIDiarizedSegment[];
}

/**
 * Transcribe a recorded blob with `gpt-4o-transcribe-diarize` and return a
 * provider-shape ScribeBatchTranscript with utterances mapped to a stable
 * speaker label scheme.
 */
export async function transcribeBatchDiarized(
  apiKey: string,
  audio: Blob,
  options: {
    language?: string;
    signal?: AbortSignal;
  } = {},
): Promise<{
  text: string;
  utterances: {
    speaker: string;
    text: string;
    start: number;
    end: number;
  }[];
}> {
  const form = new FormData();
  form.set("model", OPENAI_BATCH_DIARIZE_MODEL);
  form.set("response_format", "diarized_json");
  // Required when audio is longer than 30s; safe to always send.
  form.set("chunking_strategy", "auto");
  if (options.language) form.set("language", options.language);
  // The blob is a WebM/Opus capture; `file` requires a name with extension.
  const filename =
    audio.type === "audio/wav"
      ? "audio.wav"
      : audio.type.includes("webm")
        ? "audio.webm"
        : "audio.bin";
  form.set("file", audio, filename);

  const startedAt = performance.now();
  const res = await fetch(`${REST_BASE}/v1/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: options.signal,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as OpenAIError;
    throw new Error(
      data.error?.message ||
        `OpenAI transcription failed: ${res.status} ${res.statusText}`,
    );
  }
  const data = (await res.json()) as OpenAIDiarizedResponse;

  const utterances = (data.segments ?? []).map((s) => ({
    speaker: s.speaker || "UNKNOWN",
    text: s.text,
    start: s.start ?? 0,
    end: s.end ?? 0,
  }));
  const text =
    data.text ??
    utterances
      .map((u) => u.text)
      .join(" ")
      .trim();

  publishScribeDebug({
    level: "success",
    category: "transcribe",
    label: `batch transcribe → ${utterances.length} utterance(s)`,
    latencyMs: Math.round(performance.now() - startedAt),
    data: {
      model: OPENAI_BATCH_DIARIZE_MODEL,
      audioBytes: audio.size,
      audioType: audio.type,
      chars: text.length,
      speakers: Array.from(new Set(utterances.map((u) => u.speaker))),
    },
  });

  return { text, utterances };
}

/* ------------------------------ Extraction ------------------------------- */

interface ChatCompletionChoice {
  message?: { content?: string };
}
interface ChatCompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}
interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
  usage?: ChatCompletionUsage;
  model?: string;
}

/**
 * Run structured extraction with a small chat model. Returns an object keyed
 * by question id; values are best-effort and must be coerced by the caller.
 */
export async function gptExtract(
  apiKey: string,
  inputText: string,
  questions: {
    id: string;
    text: string;
    type: string;
    description?: string;
  }[],
  options: {
    languageHint?: string;
    keywordsHint?: string;
  } = {},
): Promise<Record<string, unknown>> {
  if (!inputText.trim() || questions.length === 0) return {};
  const startedAt = performance.now();

  const { system, user } = buildExtractionPrompt(inputText, questions, options);

  const data = await fetchJson<ChatCompletionResponse>(
    `${REST_BASE}/v1/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_EXTRACTION_MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    },
  );

  const raw = data.choices?.[0]?.message?.content?.trim() ?? "";
  let extracted: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        extracted = parsed as Record<string, unknown>;
      }
    } catch {
      /* fall through */
    }
  }

  publishScribeDebug({
    level: "success",
    category: "extract",
    label: `extract → ${Object.keys(extracted).length} field(s)`,
    latencyMs: Math.round(performance.now() - startedAt),
    tokens: {
      prompt: data.usage?.prompt_tokens,
      completion: data.usage?.completion_tokens,
      total: data.usage?.total_tokens,
    },
    data: {
      model: data.model ?? OPENAI_EXTRACTION_MODEL,
      inputChars: inputText.length,
      questionCount: questions.length,
      keys: Object.keys(extracted),
    },
  });

  return extracted;
}

/* -------------------------- Streaming extraction -------------------------- */

function buildExtractionPrompt(
  inputText: string,
  questions: {
    id: string;
    text: string;
    type: string;
    description?: string;
  }[],
  options: { languageHint?: string; keywordsHint?: string },
): { system: string; user: string } {
  const questionList = questions
    .map(
      (q) =>
        `- id: ${q.id}\n  type: ${q.type}\n  question: ${q.text}${
          q.description ? `\n  description: ${q.description}` : ""
        }`,
    )
    .join("\n");

  const langLine = options.languageHint
    ? `The transcript may be in ${options.languageHint} (often code-mixed with English drug names and medical terminology).`
    : "";
  const kwLine = options.keywordsHint
    ? `Common medical vocabulary to expect: ${options.keywordsHint}`
    : "";

  const system = `You are a clinical scribe assistant.
${langLine}
${kwLine}
You extract structured answers from a partial transcript of a doctor-patient conversation.

Rules:
- Only return values that are explicitly stated or unambiguously implied.
- Omit a key entirely if the conversation does not provide a confident answer.
- ALWAYS produce values in English, even when the transcript is in another
  language. Translate free-text answers into clear, clinical English.
  Drug names, dosages, and medical terms should use their standard English
  spellings (e.g. "paracetamol", "amoxicillin").
- For "choice" / enum-style questions, return the English option label.
- Use the question's "type" to format the value:
  - "string", "text", "url": a string (in English)
  - "integer": an integer
  - "decimal": a number (may have decimals)
  - "boolean": true or false
  - "date": ISO date "YYYY-MM-DD"
  - "dateTime": ISO datetime "YYYY-MM-DDTHH:mm:ss"
  - "time": "HH:mm" (24-hour)
- Output ONLY a JSON object mapping question id to value. No commentary.`.trim();

  const user = `Questions:
${questionList}

Transcript:
"""
${inputText}
"""

Respond with the JSON object only.`;

  return { system, user };
}

/**
 * Best-effort partial JSON parser. Walks the streamed prefix, auto-closes
 * any open string / array / object, drops trailing partial keys, and parses.
 * Returns `{}` if nothing parseable yet.
 */
export function parsePartialJsonObject(raw: string): Record<string, unknown> {
  const s = raw.trim();
  if (!s.startsWith("{")) return {};

  let inStr = false;
  let esc = false;
  const stack: string[] = [];
  let lastSafeEnd = -1;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (inStr) {
      if (c === "\\") {
        esc = true;
        continue;
      }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === "{") stack.push("}");
    else if (c === "[") stack.push("]");
    else if (c === "}" || c === "]") stack.pop();
    // Just past a value (`,` after a value in the root object) is a safe place
    // to truncate when we want a clean parse.
    if (c === "," && stack.length === 1) lastSafeEnd = i;
  }

  // Strategy 1: try parsing the whole prefix with auto-close.
  const tryParse = (text: string): Record<string, unknown> | null => {
    let candidate = text;
    if (inStr) candidate += '"';
    // Strip trailing incomplete `,"key"` or `,"key":`
    candidate = candidate.replace(/,\s*"[^"]*"\s*:?\s*$/, "");
    candidate = candidate.replace(/,\s*$/, "");
    // Append any unclosed brackets / braces.
    const closers = stack.slice().reverse().join("");
    candidate += closers;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* fall through */
    }
    return null;
  };

  const whole = tryParse(s);
  if (whole) return whole;

  // Strategy 2: truncate to the last `,` after a completed value and retry.
  if (lastSafeEnd > 0) {
    const truncated = s.slice(0, lastSafeEnd) + "}";
    try {
      const parsed = JSON.parse(truncated);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* fall through */
    }
  }
  return {};
}

/**
 * Stream a structured extraction. Calls `onProgress` with the cumulative
 * best-effort parse each time a meaningful chunk arrives. Resolves with the
 * final parsed object once the stream closes.
 */
export async function gptExtractStream(
  apiKey: string,
  inputText: string,
  questions: {
    id: string;
    text: string;
    type: string;
    description?: string;
  }[],
  onProgress: (values: Record<string, unknown>) => void,
  options: {
    languageHint?: string;
    keywordsHint?: string;
    signal?: AbortSignal;
  } = {},
): Promise<Record<string, unknown>> {
  if (!inputText.trim() || questions.length === 0) return {};
  const startedAt = performance.now();
  let firstTokenAt = 0;
  const { system, user } = buildExtractionPrompt(inputText, questions, options);

  const res = await fetch(`${REST_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_EXTRACTION_MODEL,
      temperature: 0,
      stream: true,
      stream_options: { include_usage: true },
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: options.signal,
  });
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as OpenAIError;
    throw new Error(
      data.error?.message || `OpenAI stream failed: ${res.status}`,
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  let buffer = "";
  let lastEmittedKeys = "";
  let usage: ChatCompletionUsage | undefined;
  let model: string | undefined;

  const tryEmit = () => {
    const parsed = parsePartialJsonObject(raw);
    const keys = Object.keys(parsed).sort().join("|");
    // Emit on every state change so the form fills as fast as the model
    // can stream tokens.
    if (keys !== lastEmittedKeys || keys.length > 0) {
      const isNewKeys = keys !== lastEmittedKeys;
      lastEmittedKeys = keys;
      onProgress(parsed);
      if (isNewKeys && keys.length > 0) {
        publishScribeDebug({
          level: "info",
          category: "extract",
          label: `stream → ${Object.keys(parsed).length} field(s) so far`,
          data: { keys: Object.keys(parsed) },
        });
      }
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let lineEnd: number;
    while ((lineEnd = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") break;
      try {
        const ev = JSON.parse(payload) as {
          choices?: { delta?: { content?: string } }[];
          usage?: ChatCompletionUsage;
          model?: string;
        };
        if (ev.usage) usage = ev.usage;
        if (ev.model) model = ev.model;
        const delta = ev.choices?.[0]?.delta?.content;
        if (delta) {
          if (!firstTokenAt) firstTokenAt = performance.now();
          raw += delta;
          tryEmit();
        }
      } catch {
        /* ignore malformed line */
      }
    }
  }

  // Final parse on the whole accumulated content.
  let finalValues: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      finalValues = parsed as Record<string, unknown>;
    }
  } catch {
    finalValues = parsePartialJsonObject(raw);
  }
  onProgress(finalValues);

  publishScribeDebug({
    level: "success",
    category: "extract",
    label: `extract stream → ${Object.keys(finalValues).length} field(s)`,
    latencyMs: Math.round(performance.now() - startedAt),
    tokens: {
      prompt: usage?.prompt_tokens,
      completion: usage?.completion_tokens,
      total: usage?.total_tokens,
    },
    data: {
      model: model ?? OPENAI_EXTRACTION_MODEL,
      inputChars: inputText.length,
      questionCount: questions.length,
      keys: Object.keys(finalValues),
      firstTokenMs: firstTokenAt
        ? Math.round(firstTokenAt - startedAt)
        : undefined,
      streamed: true,
    },
  });

  return finalValues;
}

/* ------------------ Realtime conversation tool schema ------------------- */

interface QuestionForSchema {
  id: string;
  text: string;
  type: string;
  description?: string;
}

/**
 * Build a JSON schema for the `update_form` tool the Realtime model will call
 * with cumulative form values. Every field is optional so the model can fill
 * partial answers without violating the schema.
 */
export function buildFormToolSchema(questions: QuestionForSchema[]): {
  type: "object";
  properties: Record<string, unknown>;
  additionalProperties: false;
} {
  const properties: Record<string, unknown> = {};
  for (const q of questions) {
    let prop: Record<string, unknown>;
    switch (q.type) {
      case "integer":
        prop = { type: "integer" };
        break;
      case "decimal":
        prop = { type: "number" };
        break;
      case "boolean":
        prop = { type: "boolean" };
        break;
      case "date":
        prop = { type: "string", description: "ISO date YYYY-MM-DD" };
        break;
      case "dateTime":
        prop = {
          type: "string",
          description: "ISO datetime YYYY-MM-DDTHH:mm:ss",
        };
        break;
      case "time":
        prop = { type: "string", description: "24-hour HH:mm" };
        break;
      default:
        // string, text, url, choice, structured — emit as English string and
        // let the form coerce. Choice questions get the English label.
        prop = { type: "string" };
    }
    const desc = q.description ? `${q.text} — ${q.description}` : q.text;
    prop = { ...prop, description: desc };
    properties[q.id] = prop;
  }
  return {
    type: "object",
    properties,
    additionalProperties: false,
  };
}

export function buildScribeInstructions(options: {
  language?: string;
  keywordsHint?: string;
}): string {
  const langLine = options.language
    ? `The audio may be in ${options.language}, often code-mixed with English drug names and medical terminology.`
    : "";
  const kwLine = options.keywordsHint
    ? `Common medical vocabulary to expect: ${options.keywordsHint}`
    : "";
  return `You are a clinical scribe assistant. You are listening live to a doctor-patient conversation.
${langLine}
${kwLine}

After every speaker turn, call the \`update_form\` function with the cumulative best-effort answers to ALL form fields you can confidently extract from the entire conversation so far. Omit any field you cannot confidently answer.

Rules:
- ALWAYS produce values in English even if the conversation is in another language. Translate free-text answers into clear, clinical English.
- Drug names, dosages, and medical terms must use their standard English spellings (e.g. "paracetamol", "amoxicillin", "twice daily").
- For choice / enum-style questions, emit the English option label.
- Do not invent values. Omit a field rather than guess.
- Never speak. Only call the \`update_form\` tool.
- Each new tool call should reflect the current state of the form (re-emit previously set values along with any new ones).`.trim();
}
