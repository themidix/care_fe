import { useCallback, useEffect, useRef, useState } from "react";

import {
  STREAMING_DOMAIN,
  STREAMING_MAX_TURN_SILENCE_MS,
  STREAMING_MIN_TURN_SILENCE_MS,
  STREAMING_SAMPLE_RATE,
  STREAMING_SPEECH_MODEL,
  STREAMING_WS_HOST,
  getStreamingToken,
} from "@/Utils/ambientScribe/assemblyai";

export interface FinalSegment {
  text: string;
  /** AssemblyAI v3 turn order, used to dedupe formatted/unformatted finals. */
  turn: number;
  /**
   * Per-turn speaker label from streaming diarization (e.g. "A", "B").
   * `"UNKNOWN"` for very short turns, `null` if diarization is disabled.
   */
  speaker: string | null;
}

interface UseAssemblyAIStreamingReturn {
  partialText: string;
  /** Speaker label for the in-progress partial (e.g. "A", "B", "UNKNOWN"). */
  partialSpeaker: string | null;
  finalSegments: FinalSegment[];
  /** Concatenation of finals + the running partial (for display & LLM input). */
  combinedText: string;
  isConnected: boolean;
  error: string | null;
  connect: () => Promise<boolean>;
  send: (chunk: Int16Array) => void;
  disconnect: () => void;
  reset: () => void;
}

interface IncomingMessage {
  type?: "Begin" | "Turn" | "Termination" | string;
  // Begin
  id?: string;
  expires_at?: number;
  // Turn
  transcript?: string;
  end_of_turn?: boolean;
  turn_is_formatted?: boolean;
  turn_order?: number;
  speaker_label?: string;
  // Errors / unknown
  error?: string;
}

/**
 * Manages a streaming connection to AssemblyAI's realtime endpoint.
 *
/**
 * Manages a streaming connection to AssemblyAI's realtime endpoint.
 *
 * Real-time speaker diarization is enabled via `speaker_labels=true`. Each
 * `Turn` event includes a `speaker_label` ("A", "B", … or `"UNKNOWN"` for
 * very short turns). Speaker accuracy improves over the course of a session
 * as the model accumulates embedding context.
 */
export function useAssemblyAIStreaming(
  apiKey: string | undefined,
): UseAssemblyAIStreamingReturn {
  const [partialText, setPartialText] = useState("");
  const [partialSpeaker, setPartialSpeaker] = useState<string | null>(null);
  const [finalSegments, setFinalSegments] = useState<FinalSegment[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const queueRef = useRef<Int16Array[]>([]);

  const flushQueue = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (queueRef.current.length > 0) {
      const chunk = queueRef.current.shift();
      if (!chunk) break;
      ws.send(chunk.buffer);
    }
  }, []);

  const reset = useCallback(() => {
    setPartialText("");
    setPartialSpeaker(null);
    setFinalSegments([]);
    setError(null);
  }, []);

  const disconnect = useCallback(() => {
    const ws = wsRef.current;
    if (ws) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "Terminate" }));
        }
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

  const connect = useCallback(async () => {
    if (!apiKey) {
      setError("missing_api_key");
      return false;
    }
    if (wsRef.current) {
      return true;
    }
    try {
      const token = await getStreamingToken(apiKey, 600);
      const params = new URLSearchParams({
        speech_model: STREAMING_SPEECH_MODEL,
        sample_rate: String(STREAMING_SAMPLE_RATE),
        format_turns: "true",
        domain: STREAMING_DOMAIN,
        speaker_labels: "true",
        min_turn_silence: String(STREAMING_MIN_TURN_SILENCE_MS),
        max_turn_silence: String(STREAMING_MAX_TURN_SILENCE_MS),
        token,
      });
      const url = `wss://${STREAMING_WS_HOST}/v3/ws?${params.toString()}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
          setIsConnected(true);
          flushQueue();
          resolve();
        };
        ws.onerror = () => {
          reject(new Error("websocket_error"));
        };
        ws.onclose = () => {
          if (wsRef.current === ws) {
            wsRef.current = null;
            setIsConnected(false);
          }
        };
        ws.onmessage = (event) => {
          let msg: IncomingMessage;
          try {
            msg = JSON.parse(event.data) as IncomingMessage;
          } catch {
            return;
          }
          if (msg.error) {
            setError(msg.error);
            return;
          }
          if (msg.type !== "Turn") return;

          const transcript = (msg.transcript ?? "").trim();
          if (!msg.end_of_turn) {
            setPartialText(transcript);
            setPartialSpeaker(msg.speaker_label ?? null);
            return;
          }
          // end_of_turn = true -> finalize. With format_turns=true a
          // formatted version may follow with the same turn_order; replace
          // the previous final entry rather than appending a duplicate.
          setPartialText("");
          setPartialSpeaker(null);
          if (!transcript) return;
          const turn = msg.turn_order ?? -1;
          const speaker = msg.speaker_label ?? null;
          setFinalSegments((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.turn === turn) {
              return [
                ...prev.slice(0, -1),
                { text: transcript, turn, speaker },
              ];
            }
            return [...prev, { text: transcript, turn, speaker }];
          });
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
      ws.send(chunk.buffer);
    } else {
      // Buffer until connected; cap to avoid runaway memory if connect fails.
      if (queueRef.current.length < 200) queueRef.current.push(chunk);
    }
  }, []);

  const combinedText =
    finalSegments.map((s) => s.text).join(" ") +
    (partialText ? ` ${partialText}` : "");

  return {
    partialText,
    partialSpeaker,
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
