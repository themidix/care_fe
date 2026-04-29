/**
 * Thin AssemblyAI client used by the Ambient Scribe POC.
 *
 * SECURITY WARNING: All requests in this file are made directly from the
 * browser using the API key shipped in the bundle (REACT_AI_VOICE_ASSEMBLYAI_API_KEY).
 * This is acceptable for an experimental, opt-in POC only. Before production
 * use, route these calls through the backend so the key is never exposed.
 */

// In dev we go through the Vite proxy to bypass CORS. In prod (where the key
// shouldn't be on the client anyway) you should swap this for a backend proxy.
const API_BASE = import.meta.env.DEV
  ? "/_assemblyai/api"
  : "https://api.assemblyai.com";

// Streaming endpoints live on a separate host in v3.
const STREAMING_BASE = import.meta.env.DEV
  ? "/_assemblyai/streaming"
  : "https://streaming.assemblyai.com";

/**
 * Speech model for streaming. Required by v3.
 * `u3-rt-pro` = Universal-3 Pro Streaming (highest accuracy).
 * See https://www.assemblyai.com/docs/streaming/universal-3-pro
 */
export const STREAMING_SPEECH_MODEL = "u3-rt-pro";
export const STREAMING_SAMPLE_RATE = 16000;

/**
 * Streaming "Medical Mode" — boosts accuracy on medication names, dosages,
 * procedures and diagnoses. Enabled by setting the `domain` connection param.
 * See https://www.assemblyai.com/docs/streaming/medical-mode
 */
export const STREAMING_DOMAIN = "medical-v1";

/**
 * Turn-detection silence thresholds (ms) recommended for medical audio so
 * mid-sentence pauses don't fragment the transcript prematurely.
 */
export const STREAMING_MIN_TURN_SILENCE_MS = 800;
export const STREAMING_MAX_TURN_SILENCE_MS = 3600;

/** Public host (not proxied) for opening the WebSocket. */
export const STREAMING_WS_HOST = "streaming.assemblyai.com";

interface AssemblyAIError {
  error?: string;
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as AssemblyAIError;
    throw new Error(data.error || `AssemblyAI ${url} failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

async function post<T>(
  path: string,
  apiKey: string,
  body: unknown,
  contentType = "application/json",
): Promise<T> {
  return fetchJson<T>(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": contentType,
    },
    body:
      contentType === "application/json"
        ? JSON.stringify(body)
        : (body as BodyInit),
  });
}

async function get<T>(path: string, apiKey: string): Promise<T> {
  return fetchJson<T>(`${API_BASE}${path}`, {
    headers: { Authorization: apiKey },
  });
}

/**
 * Mint a temporary token for the streaming WebSocket. Expires after
 * `expiresInSeconds` (1-600).
 *
 * v3 endpoint: GET https://streaming.assemblyai.com/v3/token
 */
export async function getStreamingToken(
  apiKey: string,
  expiresInSeconds = 600,
): Promise<string> {
  const data = await fetchJson<{ token: string; expires_in_seconds: number }>(
    `${STREAMING_BASE}/v3/token?expires_in_seconds=${expiresInSeconds}`,
    { headers: { Authorization: apiKey } },
  );
  return data.token;
}

/**
 * Upload a raw audio blob to AssemblyAI. Returns an `upload_url`.
 */
export async function uploadAudio(apiKey: string, blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const data = await post<{ upload_url: string }>(
    "/v2/upload",
    apiKey,
    buf,
    "application/octet-stream",
  );
  return data.upload_url;
}

export interface BatchUtterance {
  speaker: string;
  text: string;
  start: number;
  end: number;
  confidence?: number;
}

export interface BatchTranscript {
  id: string;
  status: "queued" | "processing" | "completed" | "error";
  text?: string;
  utterances?: BatchUtterance[] | null;
  error?: string;
}

/**
 * Submit a batch transcription job with speaker diarization + Medical Mode.
 *
 * - `universal-3-pro` is the recommended high-accuracy model; `universal-2`
 *   is included as a fallback for languages Universal-3 Pro doesn't yet
 *   support.
 * - `domain: "medical-v1"` enables Medical Mode for clinical-grade accuracy
 *   on drug names, dosages and diagnoses.
 *   See https://www.assemblyai.com/docs/medical-scribe-best-practices
 */
export async function requestBatchTranscript(
  apiKey: string,
  audioUrl: string,
): Promise<string> {
  const data = await post<BatchTranscript>("/v2/transcript", apiKey, {
    audio_url: audioUrl,
    speech_models: ["universal-3-pro", "universal-2"],
    domain: "medical-v1",
    speaker_labels: true,
  });
  return data.id;
}

/**
 * Poll a transcript until it completes or errors. Polls every `intervalMs` ms.
 */
export async function pollTranscript(
  apiKey: string,
  id: string,
  options: { intervalMs?: number; signal?: AbortSignal } = {},
): Promise<BatchTranscript> {
  const intervalMs = options.intervalMs ?? 3000;

  while (true) {
    if (options.signal?.aborted) {
      throw new DOMException("Polling aborted", "AbortError");
    }
    const data = await get<BatchTranscript>(`/v2/transcript/${id}`, apiKey);
    if (data.status === "completed" || data.status === "error") {
      return data;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export interface LemurExtractQuestion {
  id: string;
  text: string;
  type: string;
  description?: string;
}

/**
 * Run a LeMUR `task` over an arbitrary text input. We use `input_text` (rather
 * than `transcript_ids`) so that we can extract from a live partial transcript
 * before any batch transcript exists.
 *
 * Returns a JSON object keyed by question id. Values are best-effort — callers
 * must coerce to the appropriate ResponseValue shape.
 */
export async function lemurExtract(
  apiKey: string,
  inputText: string,
  questions: LemurExtractQuestion[],
): Promise<Record<string, unknown>> {
  const questionList = questions
    .map(
      (q) =>
        `- id: ${q.id}\n  type: ${q.type}\n  question: ${q.text}${
          q.description ? `\n  description: ${q.description}` : ""
        }`,
    )
    .join("\n");

  const prompt = `You are a clinical scribe assistant. The following is a partial transcript of a doctor-patient conversation. Extract answers to the listed questions.

Rules:
- Only return values that are explicitly stated or unambiguously implied.
- Omit a key entirely if the conversation does not provide a confident answer.
- Use the question's "type" to format the value:
  - "string", "text", "url": a string
  - "integer": an integer
  - "decimal": a number (may have decimals)
  - "boolean": true or false
  - "date": ISO date "YYYY-MM-DD"
  - "dateTime": ISO datetime "YYYY-MM-DDTHH:mm:ss"
  - "time": "HH:mm" (24-hour)
- Output ONLY a JSON object mapping question id to value, with no commentary, no markdown, no code fences.

Questions:
${questionList}

Transcript:
"""
${inputText}
"""

Respond with the JSON object only.`;

  const data = await post<{ response: string }>(
    "/lemur/v3/generate/task",
    apiKey,
    {
      prompt,
      input_text: inputText,
      final_model: "anthropic/claude-sonnet-4-20250514",
      max_output_size: 2000,
      temperature: 0,
    },
  );

  const raw = data.response.trim();
  // Strip code fences if the model included them despite instructions.
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(stripped);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}
