import { useCallback, useEffect, useRef, useState } from "react";

import {
  OPENAI_REALTIME_CHAT_MODEL,
  OPENAI_REALTIME_MODEL,
  OPENAI_REALTIME_WS_HOST,
  OPENAI_SAMPLE_RATE,
  OPENAI_VAD_PREFIX_PADDING_MS,
  OPENAI_VAD_SILENCE_DURATION_MS,
  OPENAI_VAD_THRESHOLD,
  buildFormToolSchema,
  buildScribeInstructions,
  getRealtimeTranscriptionToken,
  parsePartialJsonObject,
} from "@/Utils/ambientScribe/openai";
import type {
  ScribeExtractQuestion,
  ScribeFinalSegment,
  ScribeStreamingState,
} from "@/Utils/ambientScribe/providers/types";
import { publishScribeDebug } from "@/Utils/ambientScribe/scribeDebugBus";

interface IncomingMessage {
  type?: string;
  /** Set on transcription delta/completed events. */
  transcript?: string;
  delta?: string;
  /** Identifies which buffered item this transcription belongs to. */
  item_id?: string;
  /** Function call streaming events. */
  call_id?: string;
  /** Errors. */
  error?: { message?: string };
}

/**
 * Encode an Int16Array PCM chunk to base64 for `input_audio_buffer.append`.
 */
function int16ToBase64(chunk: Int16Array): string {
  const bytes = new Uint8Array(
    chunk.buffer,
    chunk.byteOffset,
    chunk.byteLength,
  );
  let binary = "";
  // ~64KB at a time stays under the call-stack arg limit.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK)),
    );
  }
  return btoa(binary);
}

/**
 * Streaming hook for OpenAI Realtime.
 *
 * Two operating modes selected by whether `questions` are provided:
 *
 * 1. **Transcription mode** (no questions) — `wss://...?intent=transcription`.
 *    Connects with the dedicated transcription session and only emits
 *    transcript events. Used when the caller doesn't need live extraction.
 *
 * 2. **Unified scribe mode** (`questions` present) — full Realtime
 *    conversation model. Streams transcript events AND a forced
 *    `update_form` function call whose JSON arguments fill the form live.
 *    The same audio stream powers both — no second LLM round-trip needed.
 *
 * OpenAI Realtime does not produce per-turn speaker labels live, so
 * `partialSpeaker` and `finalSegments[].speaker` are always `null`.
 * Diarization comes from the post-stop `gpt-4o-transcribe-diarize` call.
 */
export function useOpenAIRealtimeStreaming(
  apiKey: string | undefined,
  config: {
    language?: string;
    prompt?: string;
    /** When provided, switches the hook into unified scribe mode. */
    questions?: ScribeExtractQuestion[];
    /**
     * Called with the cumulative best-effort parse of the model's
     * `update_form` tool call as JSON arguments stream in.
     */
    onExtractionProgress?: (values: Record<string, unknown>) => void;
  } = {},
): ScribeStreamingState {
  const [partialText, setPartialText] = useState("");
  const [finalSegments, setFinalSegments] = useState<ScribeFinalSegment[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const queueRef = useRef<Int16Array[]>([]);
  const turnCounterRef = useRef(0);
  /** Maps an `item_id` to its turn order so deltas/completions co-locate. */
  const itemTurnRef = useRef<Map<string, number>>(new Map());
  /** Per-item rolling partial text. */
  const itemPartialRef = useRef<Map<string, string>>(new Map());
  /** Streamed `update_form` function-call argument buffers, keyed by item_id. */
  const fnArgsRef = useRef<Map<string, string>>(new Map());
  /** Last-emitted key set, to throttle duplicate progress events. */
  const lastEmittedKeysRef = useRef<string>("");

  const flushQueue = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (queueRef.current.length > 0) {
      const chunk = queueRef.current.shift();
      if (!chunk) break;
      ws.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: int16ToBase64(chunk),
        }),
      );
    }
  }, []);

  const reset = useCallback(() => {
    setPartialText("");
    setFinalSegments([]);
    setError(null);
    turnCounterRef.current = 0;
    itemTurnRef.current.clear();
    itemPartialRef.current.clear();
    fnArgsRef.current.clear();
    lastEmittedKeysRef.current = "";
  }, []);

  const disconnect = useCallback(() => {
    const ws = wsRef.current;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* noop */
      }
    }
    wsRef.current = null;
    queueRef.current = [];
    setIsConnected(false);
  }, []);

  useEffect(() => () => disconnect(), [disconnect]);

  // Stable refs for `connect`'s dependency list — config object identity may
  // change on every render but its content is what matters.
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  }, [config]);

  const connect = useCallback(async () => {
    if (!apiKey) {
      setError("missing_api_key");
      return false;
    }
    if (wsRef.current) return true;

    const useUnifiedMode =
      !!configRef.current.questions &&
      configRef.current.questions.length > 0 &&
      !!configRef.current.onExtractionProgress;

    try {
      let url: string;
      let token: string;
      if (useUnifiedMode) {
        // Conversation mode authenticates with the long-lived API key via
        // subprotocol (consistent with the rest of the POC). Model is
        // selected via the `model` query param.
        url = `wss://${OPENAI_REALTIME_WS_HOST}/v1/realtime?model=${OPENAI_REALTIME_CHAT_MODEL}`;
        token = apiKey;
      } else {
        token = await getRealtimeTranscriptionToken(apiKey, {
          language: configRef.current.language,
          prompt: configRef.current.prompt,
        });
        url = `wss://${OPENAI_REALTIME_WS_HOST}/v1/realtime?intent=transcription`;
      }

      // Browsers can't set Authorization headers on WS; OpenAI accepts the
      // ephemeral token via the WebSocket subprotocol mechanism.
      const ws = new WebSocket(url, [
        "realtime",
        `openai-insecure-api-key.${token}`,
        "openai-beta.realtime-v1",
      ]);
      wsRef.current = ws;

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
          publishScribeDebug({
            level: "success",
            category: "ws",
            label: useUnifiedMode ? "ws open (unified)" : "ws open",
            data: {
              model: useUnifiedMode
                ? OPENAI_REALTIME_CHAT_MODEL
                : OPENAI_REALTIME_MODEL,
              language: configRef.current.language,
              sampleRate: OPENAI_SAMPLE_RATE,
              questions: configRef.current.questions?.length ?? 0,
              mode: useUnifiedMode ? "conversation+tool" : "transcription-only",
            },
          });

          if (useUnifiedMode) {
            // Full Realtime conversation session with a forced tool that
            // emits the structured form values.
            const schema = buildFormToolSchema(configRef.current.questions!);
            const instructions = buildScribeInstructions({
              language: configRef.current.language,
              keywordsHint: configRef.current.prompt,
            });
            ws.send(
              JSON.stringify({
                type: "session.update",
                session: {
                  modalities: ["text"],
                  instructions,
                  input_audio_format: "pcm16",
                  input_audio_transcription: {
                    model: OPENAI_REALTIME_MODEL,
                    ...(configRef.current.language
                      ? { language: configRef.current.language }
                      : {}),
                  },
                  turn_detection: {
                    type: "server_vad",
                    threshold: OPENAI_VAD_THRESHOLD,
                    prefix_padding_ms: OPENAI_VAD_PREFIX_PADDING_MS,
                    silence_duration_ms: OPENAI_VAD_SILENCE_DURATION_MS,
                    create_response: true,
                    interrupt_response: false,
                  },
                  input_audio_noise_reduction: { type: "near_field" },
                  tools: [
                    {
                      type: "function",
                      name: "update_form",
                      description:
                        "Set or update one or more form field values based on the conversation so far. Always include the cumulative state of all confidently-known fields.",
                      parameters: schema,
                    },
                  ],
                  tool_choice: { type: "function", name: "update_form" },
                },
              }),
            );
          } else {
            // Transcription-only session.
            ws.send(
              JSON.stringify({
                type: "transcription_session.update",
                input_audio_format: "pcm16",
                input_audio_transcription: {
                  model: OPENAI_REALTIME_MODEL,
                  ...(configRef.current.language
                    ? { language: configRef.current.language }
                    : {}),
                  ...(configRef.current.prompt
                    ? { prompt: configRef.current.prompt }
                    : {}),
                },
                turn_detection: {
                  type: "server_vad",
                  threshold: OPENAI_VAD_THRESHOLD,
                  prefix_padding_ms: OPENAI_VAD_PREFIX_PADDING_MS,
                  silence_duration_ms: OPENAI_VAD_SILENCE_DURATION_MS,
                },
                input_audio_noise_reduction: { type: "near_field" },
              }),
            );
          }
          setIsConnected(true);
          flushQueue();
          resolve();
        };

        ws.onerror = () => {
          publishScribeDebug({
            level: "error",
            category: "ws",
            label: "ws error",
          });
          reject(new Error("websocket_error"));
        };

        ws.onclose = (event) => {
          if (wsRef.current === ws) {
            wsRef.current = null;
            setIsConnected(false);
          }
          publishScribeDebug({
            level: event.wasClean ? "info" : "warn",
            category: "ws",
            label: `ws close (${event.code})`,
            data: { reason: event.reason || undefined },
          });
        };

        ws.onmessage = (event) => {
          let msg: IncomingMessage;
          try {
            msg = JSON.parse(event.data) as IncomingMessage;
          } catch {
            return;
          }
          if (msg.error?.message) {
            setError(msg.error.message);
            return;
          }
          const t = msg.type;
          if (!t) return;

          // Live partial transcription as the model decodes incoming audio.
          if (
            t === "conversation.item.input_audio_transcription.delta" &&
            msg.item_id
          ) {
            const itemId = msg.item_id;
            if (!itemTurnRef.current.has(itemId)) {
              itemTurnRef.current.set(itemId, turnCounterRef.current++);
            }
            const prev = itemPartialRef.current.get(itemId) ?? "";
            const next = msg.delta
              ? prev + msg.delta
              : (msg.transcript ?? prev);
            itemPartialRef.current.set(itemId, next);
            setPartialText(next.trim());
            return;
          }

          if (
            t === "conversation.item.input_audio_transcription.completed" &&
            msg.item_id
          ) {
            const itemId = msg.item_id;
            const text = (msg.transcript ?? "").trim();
            if (!text) {
              itemPartialRef.current.delete(itemId);
              setPartialText("");
              return;
            }
            const turn =
              itemTurnRef.current.get(itemId) ?? turnCounterRef.current++;
            itemPartialRef.current.delete(itemId);
            setPartialText("");
            setFinalSegments((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.turn === turn) {
                return [...prev.slice(0, -1), { text, turn, speaker: null }];
              }
              return [...prev, { text, turn, speaker: null }];
            });
            return;
          }

          // === Unified scribe mode: streamed function-call arguments ===
          if (t === "response.function_call_arguments.delta" && msg.item_id) {
            const itemId = msg.item_id;
            const prev = fnArgsRef.current.get(itemId) ?? "";
            const next = prev + (msg.delta ?? "");
            fnArgsRef.current.set(itemId, next);
            const parsed = parsePartialJsonObject(next);
            const keys = Object.keys(parsed).sort().join("|");
            if (keys.length > 0 && keys !== lastEmittedKeysRef.current) {
              lastEmittedKeysRef.current = keys;
              configRef.current.onExtractionProgress?.(parsed);
              publishScribeDebug({
                level: "info",
                category: "extract",
                label: `realtime tool → ${Object.keys(parsed).length} field(s)`,
                data: { keys: Object.keys(parsed) },
              });
            } else if (keys.length > 0) {
              // Same key set, but values may have refined — still notify.
              configRef.current.onExtractionProgress?.(parsed);
            }
            return;
          }

          if (t === "response.function_call_arguments.done" && msg.item_id) {
            const itemId = msg.item_id;
            const raw =
              fnArgsRef.current.get(itemId) ??
              (msg as { arguments?: string }).arguments ??
              "";
            fnArgsRef.current.delete(itemId);
            try {
              const parsed = JSON.parse(raw);
              if (
                parsed &&
                typeof parsed === "object" &&
                !Array.isArray(parsed)
              ) {
                configRef.current.onExtractionProgress?.(
                  parsed as Record<string, unknown>,
                );
                publishScribeDebug({
                  level: "success",
                  category: "extract",
                  label: `realtime tool done → ${Object.keys(parsed).length} field(s)`,
                  data: { keys: Object.keys(parsed) },
                });
              }
            } catch {
              const partial = parsePartialJsonObject(raw);
              if (Object.keys(partial).length > 0) {
                configRef.current.onExtractionProgress?.(partial);
              }
            }
            // Acknowledge the tool call so the model is free to continue.
            // We send back an empty success result.
            const callId = (msg as { call_id?: string }).call_id;
            if (callId && wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(
                JSON.stringify({
                  type: "conversation.item.create",
                  item: {
                    type: "function_call_output",
                    call_id: callId,
                    output: JSON.stringify({ ok: true }),
                  },
                }),
              );
            }
            return;
          }

          // Track Realtime usage for the debug panel.
          if (t === "response.done") {
            const usage = (
              msg as {
                response?: {
                  usage?: {
                    input_tokens?: number;
                    output_tokens?: number;
                    total_tokens?: number;
                  };
                };
              }
            ).response?.usage;
            if (usage) {
              publishScribeDebug({
                level: "info",
                category: "token",
                label: "realtime response.done",
                tokens: {
                  prompt: usage.input_tokens,
                  completion: usage.output_tokens,
                  total: usage.total_tokens,
                },
              });
            }
            return;
          }

          // Surface server-side errors.
          if (t === "error") {
            const m = (msg as { error?: { message?: string } }).error?.message;
            if (m) setError(m);
          }
        };
      });
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "connect_failed");
      wsRef.current?.close();
      wsRef.current = null;
      setIsConnected(false);
      return false;
    }
  }, [apiKey, flushQueue]);

  const send = useCallback((chunk: Int16Array) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: int16ToBase64(chunk),
        }),
      );
    } else {
      if (queueRef.current.length < 200) queueRef.current.push(chunk);
    }
  }, []);

  const combinedText =
    finalSegments.map((s) => s.text).join(" ") +
    (partialText ? ` ${partialText}` : "");

  return {
    partialText,
    partialSpeaker: null,
    finalSegments,
    combinedText: combinedText.trim(),
    isConnected,
    error,
    connect,
    send,
    disconnect,
    reset,
  };
}

export { OPENAI_SAMPLE_RATE };
