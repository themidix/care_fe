/**
 * Provider abstraction for the Ambient Scribe.
 *
 * Each provider exposes:
 *   - a streaming React hook (live partials/finals over WS),
 *   - a one-shot batch transcription (post-stop, ideally with diarization),
 *   - an LLM extraction call (transcript text + questions -> values).
 *
 * Implementations live alongside this file. `useAmbientScribe` selects one
 * via the registry in `./index.ts` based on `careConfig.ambientScribe.provider`.
 */

export interface ScribeFinalSegment {
  text: string;
  /** Provider-defined turn order; used to dedupe formatted/unformatted finals. */
  turn: number;
  /**
   * Per-turn speaker label ("A", "B", "doctor", or "UNKNOWN"). `null` when
   * the provider does not support live diarization (e.g. OpenAI Realtime).
   */
  speaker: string | null;
}

export interface ScribeStreamingState {
  partialText: string;
  partialSpeaker: string | null;
  finalSegments: ScribeFinalSegment[];
  /** Concatenation of finals + the running partial (for display & LLM input). */
  combinedText: string;
  isConnected: boolean;
  error: string | null;
  connect: () => Promise<boolean>;
  send: (chunk: Int16Array) => void;
  disconnect: () => void;
  reset: () => void;
}

export interface ScribeUtterance {
  speaker: string;
  text: string;
  start: number;
  end: number;
  confidence?: number;
}

export interface ScribeBatchTranscript {
  id?: string;
  status: "queued" | "processing" | "completed" | "error";
  text?: string;
  utterances?: ScribeUtterance[] | null;
  error?: string;
}

export interface ScribeExtractQuestion {
  id: string;
  text: string;
  type: string;
  description?: string;
}

/**
 * Audio capture format the provider expects from `usePcmRecorder`.
 * Both providers we ship use 16-bit little-endian PCM at 16kHz mono.
 */
export interface ScribeAudioFormat {
  sampleRate: number;
}

export interface AsrLlmProvider {
  /** Stable provider name used in config + logs. */
  readonly name: "assemblyai" | "openai";
  /** PCM format the provider's streaming session expects. */
  readonly audioFormat: ScribeAudioFormat;
  /**
   * Maximum WAV/blob size or duration the batch endpoint accepts. Informational;
   * `useAmbientScribe` does not split blobs today.
   */
  readonly batchMaxBytes?: number;
  /**
   * When `true`, the streaming hook itself emits structured form values via
   * the `onExtractionProgress` callback (e.g. via a Realtime tool call) and
   * `useAmbientScribe` will skip its separate periodic `extract`/`extractStream`
   * calls. The post-stop batch transcript is still produced.
   */
  readonly extractionFromStream?: boolean;

  /**
   * Streaming hook. Must follow Rules of Hooks - call unconditionally from
   * `useAmbientScribe`. Returns `connect()` / `send()` / `disconnect()` plus
   * live transcript state.
   *
   * `options.questions` and `options.onExtractionProgress` are only honoured
   * by providers that set `extractionFromStream`.
   */
  useStreaming: (
    apiKey: string | undefined,
    options?: {
      questions?: ScribeExtractQuestion[];
      onExtractionProgress?: (values: Record<string, unknown>) => void;
    },
  ) => ScribeStreamingState;

  /**
   * Run a one-shot transcription on the full recording. Should return a
   * completed transcript with diarized utterances when supported.
   */
  transcribeBatch: (
    apiKey: string,
    audio: Blob,
    options?: { signal?: AbortSignal },
  ) => Promise<ScribeBatchTranscript>;

  /**
   * Extract answers for `questions` from `text`. Return only confidently
   * answered keys; omit the rest. Values must be coercible by
   * `coerceValueByType`.
   */
  extract: (
    apiKey: string,
    text: string,
    questions: ScribeExtractQuestion[],
    options?: {
      /** Optional Malayalam / domain hint for the LLM prompt. */
      languageHint?: string;
      /** Optional medical formulary / vocabulary hint. */
      keywordsHint?: string;
    },
  ) => Promise<Record<string, unknown>>;

  /**
   * Streaming variant of `extract`. As the model emits the JSON answer,
   * `onProgress` is fired with the cumulative best-effort parse so the form
   * can fill field-by-field. The final resolved value is returned when the
   * stream completes. Optional — providers without streaming support omit
   * this and `useAmbientScribe` falls back to `extract`.
   */
  extractStream?: (
    apiKey: string,
    text: string,
    questions: ScribeExtractQuestion[],
    onProgress: (values: Record<string, unknown>) => void,
    options?: {
      languageHint?: string;
      keywordsHint?: string;
      signal?: AbortSignal;
    },
  ) => Promise<Record<string, unknown>>;
}
