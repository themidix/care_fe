import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import careConfig from "@careConfig";

import {
  type AsrLlmProvider,
  getProvider,
  getProviderApiKey,
} from "@/Utils/ambientScribe/providers";
import type {
  ScribeBatchTranscript,
  ScribeExtractQuestion,
} from "@/Utils/ambientScribe/providers/types";
import { publishScribeDebug } from "@/Utils/ambientScribe/scribeDebugBus";
import { usePcmRecorder } from "@/Utils/ambientScribe/usePcmRecorder";
import type { Question } from "@/types/questionnaire/question";

import { getFillableQuestions } from "@/components/Questionnaire/AmbientScribe/extraction";

export type ScribePhase =
  | "idle"
  | "connecting"
  | "listening"
  | "stopping"
  | "ready_for_review";

export interface ScribeExtraction {
  /** Raw values keyed by question_id, as returned by the LLM. */
  values: Record<string, unknown>;
  /** Monotonic timestamp; consumers can `useEffect` on this. */
  ts: number;
}

export interface UseAmbientScribeArgs {
  questions: Question[];
  /** Called whenever a new extraction lands (live or final pass). */
  onExtraction?: (extraction: ScribeExtraction) => void;
}

export interface UseAmbientScribeReturn {
  phase: ScribePhase;
  partialText: string;
  partialSpeaker: string | null;
  finalSegments: { text: string; turn: number; speaker: string | null }[];
  combinedText: string;
  /** Set after the post-stop batch transcription completes. */
  batchTranscript: ScribeBatchTranscript | null;
  level: number;
  elapsedMs: number;
  isExtracting: boolean;
  error: string | null;
  /** Active provider name, useful for diagnostics. */
  providerName: AsrLlmProvider["name"];
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export function useAmbientScribe({
  questions,
  onExtraction,
}: UseAmbientScribeArgs): UseAmbientScribeReturn {
  // Resolve the provider once per hook instance. `getProvider` reads
  // careConfig at call time; provider modules are stateless singletons.
  const provider = useMemo(() => getProvider(), []);
  const apiKey = useMemo(() => getProviderApiKey(provider), [provider]);

  const [phase, setPhase] = useState<ScribePhase>("idle");
  const [batchTranscript, setBatchTranscript] =
    useState<ScribeBatchTranscript | null>(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fillableQuestions = useMemo(
    () => getFillableQuestions(questions),
    [questions],
  );

  const extractQuestions: ScribeExtractQuestion[] = useMemo(
    () =>
      fillableQuestions.map((q) => ({
        id: q.id,
        text: q.text,
        type: q.type,
        description: q.description,
      })),
    [fillableQuestions],
  );

  // Hold the latest `onExtraction` in a ref so consumers don't have to memoize.
  const onExtractionRef = useRef(onExtraction);
  useEffect(() => {
    onExtractionRef.current = onExtraction;
  }, [onExtraction]);

  const streaming = provider.useStreaming(apiKey);

  const recorder = usePcmRecorder({
    onChunk: (chunk) => streaming.send(chunk),
    sampleRate: provider.audioFormat.sampleRate,
    maxDurationMs: careConfig.ambientScribe.maxRecordingMs,
    onMaxDuration: () => {
      void stopRef.current?.();
    },
  });

  const lastExtractedTextRef = useRef("");
  const inFlightRef = useRef(false);

  const runExtraction = useCallback(
    async (text: string) => {
      if (!apiKey || !text) return;
      if (text === lastExtractedTextRef.current) return;
      if (inFlightRef.current) return;
      if (extractQuestions.length === 0) return;
      inFlightRef.current = true;
      lastExtractedTextRef.current = text;
      setIsExtracting(true);
      try {
        if (provider.extractStream) {
          // Streaming path: fire onExtraction with the cumulative parse on
          // each chunk so the form fills field-by-field as tokens arrive.
          await provider.extractStream(
            apiKey,
            text,
            extractQuestions,
            (values) => {
              onExtractionRef.current?.({ values, ts: Date.now() });
            },
          );
        } else {
          const extracted = await provider.extract(
            apiKey,
            text,
            extractQuestions,
          );
          onExtractionRef.current?.({ values: extracted, ts: Date.now() });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "extraction_error";
        publishScribeDebug({
          level: "error",
          category: "error",
          label: `extract failed: ${msg}`,
        });
        setError(msg);
      } finally {
        inFlightRef.current = false;
        setIsExtracting(false);
      }
    },
    [apiKey, extractQuestions, provider],
  );

  // Drive extractions directly from transcript changes — no fixed cadence.
  // The in-flight guard means at most one extraction runs at a time; when
  // it completes we immediately re-fire if the transcript moved on.
  useEffect(() => {
    if (phase !== "listening") return;
    if (!streaming.combinedText) return;
    if (streaming.combinedText === lastExtractedTextRef.current) return;
    if (inFlightRef.current) return;
    void runExtraction(streaming.combinedText);
  }, [phase, runExtraction, streaming.combinedText]);

  const start = useCallback(async () => {
    if (!apiKey) {
      setError("missing_api_key");
      return;
    }
    setError(null);
    setBatchTranscript(null);
    streaming.reset();
    lastExtractedTextRef.current = "";
    setPhase("connecting");

    const ok = await streaming.connect();
    if (!ok) {
      setPhase("idle");
      setError(streaming.error || "connect_failed");
      return;
    }

    const started = await recorder.start();
    if (!started) {
      streaming.disconnect();
      setPhase("idle");
      setError(recorder.error || "recorder_error");
      return;
    }
    setPhase("listening");
  }, [apiKey, recorder, streaming]);

  const stop = useCallback(async () => {
    if (phase !== "listening") return;
    setPhase("stopping");
    const blob = await recorder.stop();
    streaming.disconnect();

    if (!apiKey || !blob) {
      setPhase("ready_for_review");
      return;
    }

    try {
      // One final live extraction on whatever was streamed before stopping
      // — gives the form one more refresh while the batch pass is in-flight.
      if (streaming.combinedText) {
        try {
          await runExtraction(streaming.combinedText);
        } catch {
          /* swallow */
        }
      }

      const transcript = await provider.transcribeBatch(apiKey, blob);
      setBatchTranscript(transcript);

      if (transcript.status === "completed" && transcript.text) {
        try {
          const extracted = await provider.extract(
            apiKey,
            transcript.text,
            extractQuestions,
          );
          lastExtractedTextRef.current = transcript.text;
          onExtractionRef.current?.({ values: extracted, ts: Date.now() });
        } catch (e) {
          setError(e instanceof Error ? e.message : "extraction_error");
        }
      } else if (transcript.status === "error") {
        setError(transcript.error || "transcription_error");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "transcription_error");
    } finally {
      setPhase("ready_for_review");
    }
  }, [
    apiKey,
    extractQuestions,
    phase,
    provider,
    recorder,
    runExtraction,
    streaming,
  ]);

  const stopRef = useRef(stop);
  useEffect(() => {
    stopRef.current = stop;
  }, [stop]);

  return {
    phase,
    partialText: streaming.partialText,
    partialSpeaker: streaming.partialSpeaker,
    finalSegments: streaming.finalSegments,
    combinedText: streaming.combinedText,
    batchTranscript,
    level: recorder.level,
    elapsedMs: recorder.elapsedMs,
    isExtracting,
    error,
    providerName: provider.name,
    start,
    stop,
  };
}
