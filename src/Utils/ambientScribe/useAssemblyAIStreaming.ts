import { useCallback, useEffect, useRef, useState } from "react";

import {
  STREAMING_SAMPLE_RATE,
  STREAMING_SPEECH_MODEL,
  STREAMING_WS_HOST,
  getStreamingToken,
} from "@/Utils/ambientScribe/assemblyai";

export interface FinalSegment {
  text: string;
  /** AssemblyAI v3 turn order, used to dedupe formatted/unformatted finals. */
  turn: number;
}

interface UseAssemblyAIStreamingReturn {
  partialText: string;
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
  // Errors / unknown
  error?: string;
}

/**
 * Manages a streaming connection to AssemblyAI's realtime endpoint.
 *
 * Note: the streaming product does not provide speaker diarization. Call
 * the batch transcription endpoint (with `speaker_labels: true`) on the
 * full recording for diarized output.
 */
export function useAssemblyAIStreaming(
  apiKey: string | undefined,
): UseAssemblyAIStreamingReturn {
  const [partialText, setPartialText] = useState("");
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
            return;
          }
          // end_of_turn = true -> finalize. With format_turns=true a
          // formatted version may follow with the same turn_order; replace
          // the previous final entry rather than appending a duplicate.
          setPartialText("");
          if (!transcript) return;
          const turn = msg.turn_order ?? -1;
          setFinalSegments((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.turn === turn) {
              return [...prev.slice(0, -1), { text: transcript, turn }];
            }
            return [...prev, { text: transcript, turn }];
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
