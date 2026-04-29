import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import careConfig from "@careConfig";

import {
  type BatchTranscript,
  type LemurExtractQuestion,
  lemurExtract,
  pollTranscript,
  requestBatchTranscript,
  uploadAudio,
} from "@/Utils/ambientScribe/assemblyai";
import { useAssemblyAIStreaming } from "@/Utils/ambientScribe/useAssemblyAIStreaming";
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
  /** Raw values keyed by question_id, as returned by LeMUR. */
  values: Record<string, unknown>;
  /** Monotonic increasing timestamp; consumers can `useEffect` on this. */
  ts: number;
}

export interface UseAmbientScribeArgs {
  questions: Question[];
  /** Called whenever a new LeMUR extraction lands (live or final pass). */
  onExtraction?: (extraction: ScribeExtraction) => void;
}

export interface UseAmbientScribeReturn {
  phase: ScribePhase;
  partialText: string;
  partialSpeaker: string | null;
  finalSegments: { text: string; turn: number; speaker: string | null }[];
  combinedText: string;
  /** Set after batch transcription completes. */
  batchTranscript: BatchTranscript | null;
  level: number;
  elapsedMs: number;
  isExtracting: boolean;
  error: string | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export function useAmbientScribe({
  questions,
  onExtraction,
}: UseAmbientScribeArgs): UseAmbientScribeReturn {
  const apiKey = careConfig.ambientScribe.assemblyAIApiKey;

  const [phase, setPhase] = useState<ScribePhase>("idle");
  const [batchTranscript, setBatchTranscript] =
    useState<BatchTranscript | null>(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fillableQuestions = useMemo(
    () => getFillableQuestions(questions),
    [questions],
  );

  const lemurQuestions: LemurExtractQuestion[] = useMemo(
    () =>
      fillableQuestions.map((q) => ({
        id: q.id,
        text: q.text,
        type: q.type,
        description: q.description,
      })),
    [fillableQuestions],
  );

  const streaming = useAssemblyAIStreaming(apiKey);

  const recorder = usePcmRecorder({
    onChunk: (chunk) => streaming.send(chunk),
    maxDurationMs: careConfig.ambientScribe.maxRecordingMs,
    onMaxDuration: () => {
      void stopRef.current?.();
    },
  });

  // Hold the latest `onExtraction` in a ref so consumers don't have to memoize.
  const onExtractionRef = useRef(onExtraction);
  useEffect(() => {
    onExtractionRef.current = onExtraction;
  }, [onExtraction]);

  const lastExtractedTextRef = useRef("");
  const inFlightRef = useRef(false);

  const runExtraction = useCallback(
    async (text: string) => {
      if (!apiKey || !text || text === lastExtractedTextRef.current) return;
      if (inFlightRef.current) return;
      if (lemurQuestions.length === 0) return;
      inFlightRef.current = true;
      setIsExtracting(true);
      try {
        const extracted = await lemurExtract(apiKey, text, lemurQuestions);
        lastExtractedTextRef.current = text;
        onExtractionRef.current?.({ values: extracted, ts: Date.now() });
      } catch (e) {
        setError(e instanceof Error ? e.message : "extraction_error");
      } finally {
        inFlightRef.current = false;
        setIsExtracting(false);
      }
    },
    [apiKey, lemurQuestions],
  );

  // Live polling loop
  useEffect(() => {
    if (phase !== "listening") return;
    const interval = window.setInterval(() => {
      void runExtraction(streaming.combinedText);
    }, careConfig.ambientScribe.liveFillIntervalMs);
    return () => window.clearInterval(interval);
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
      if (streaming.combinedText) {
        try {
          await runExtraction(streaming.combinedText);
        } catch {
          /* swallow */
        }
      }

      const uploadUrl = await uploadAudio(apiKey, blob);
      const transcriptId = await requestBatchTranscript(apiKey, uploadUrl);
      const transcript = await pollTranscript(apiKey, transcriptId, {
        intervalMs: 3000,
      });
      setBatchTranscript(transcript);

      if (transcript.status === "completed" && transcript.text) {
        try {
          const extracted = await lemurExtract(
            apiKey,
            transcript.text,
            lemurQuestions,
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
  }, [apiKey, lemurQuestions, phase, recorder, runExtraction, streaming]);

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
    start,
    stop,
  };
}
