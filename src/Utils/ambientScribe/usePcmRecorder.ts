/* eslint-disable @typescript-eslint/no-deprecated -- ScriptProcessorNode is
   deprecated in favour of AudioWorklet, but is sufficient for this POC and
   avoids shipping a separate worklet module. */
import { useCallback, useEffect, useRef, useState } from "react";

import { useMediaDevicePermission } from "@/Utils/useMediaDevicePermission";

const DEFAULT_SAMPLE_RATE = 16000;

interface UsePcmRecorderOptions {
  /** Called with each ~50ms PCM 16-bit mono chunk while recording. */
  onChunk?: (chunk: Int16Array) => void;
  /** Hard cap on total recording duration (ms). */
  maxDurationMs?: number;
  /** Invoked when the recorder auto-stops because of `maxDurationMs`. */
  onMaxDuration?: () => void;
  /**
   * Target sample rate (Hz) for the streamed Int16 PCM chunks and the WAV
   * blob returned by `stop()`. Defaults to 16000 (AssemblyAI). Use 24000
   * for OpenAI Realtime.
   */
  sampleRate?: number;
}

interface UsePcmRecorderReturn {
  isRecording: boolean;
  /** RMS level (0..1) of the most recent chunk, for waveform UI. */
  level: number;
  /** Elapsed recording time in ms. */
  elapsedMs: number;
  start: () => Promise<boolean>;
  stop: () => Promise<Blob | null>;
  error: string | null;
}

/**
 * Records mic audio as 16 kHz mono Int16 PCM, both streamed via `onChunk`
 * and accumulated for a final WAV blob returned from `stop()`.
 *
 * Uses ScriptProcessorNode (deprecated but universally supported) — fine
 * for a POC. AudioWorklet would be the modern path.
 */
export function usePcmRecorder(
  options: UsePcmRecorderOptions = {},
): UsePcmRecorderReturn {
  const { onChunk, maxDurationMs, onMaxDuration } = options;
  const targetSampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;

  const { requestPermission } = useMediaDevicePermission();

  const [isRecording, setIsRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const chunksRef = useRef<Int16Array[]>([]);
  const startedAtRef = useRef<number>(0);
  const tickRef = useRef<number | null>(null);
  // Latest callback refs to avoid restarting the recorder on prop changes.
  const onChunkRef = useRef(onChunk);
  const onMaxDurationRef = useRef(onMaxDuration);
  useEffect(() => {
    onChunkRef.current = onChunk;
    onMaxDurationRef.current = onMaxDuration;
  }, [onChunk, onMaxDuration]);

  const cleanup = useCallback(() => {
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
      audioCtxRef.current.close().catch(() => {
        /* noop */
      });
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    processorRef.current = null;
    sourceRef.current = null;
    audioCtxRef.current = null;
    streamRef.current = null;
  }, []);

  useEffect(() => () => cleanup(), [cleanup]);

  const start = useCallback(async () => {
    if (isRecording) return true;
    setError(null);
    chunksRef.current = [];

    const { hasPermission, mediaStream } = await requestPermission({
      audio: true,
    });
    if (!hasPermission || !mediaStream) {
      setError("permission_denied");
      return false;
    }

    streamRef.current = mediaStream;

    const AudioCtx = (window.AudioContext ||
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).webkitAudioContext) as typeof AudioContext;
    const audioCtx = new AudioCtx({ sampleRate: targetSampleRate });
    audioCtxRef.current = audioCtx;

    const source = audioCtx.createMediaStreamSource(mediaStream);
    sourceRef.current = source;

    // bufferSize 4096 @ 16kHz ~= 256ms per buffer. Browsers may cap the
    // negotiated sample rate, in which case we resample below.
    const bufferSize = 4096;
    const processor = audioCtx.createScriptProcessor(bufferSize, 1, 1);
    processorRef.current = processor;

    const ctxRate = audioCtx.sampleRate;
    const needsResample = ctxRate !== targetSampleRate;

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const float = needsResample
        ? downsample(input, ctxRate, targetSampleRate)
        : input;
      const int16 = floatToInt16(float);
      chunksRef.current.push(int16);

      // RMS for level meter
      let sumSq = 0;
      for (let i = 0; i < float.length; i++) sumSq += float[i] * float[i];
      const rms = Math.sqrt(sumSq / float.length);
      setLevel(Math.min(1, rms * 4));

      onChunkRef.current?.(int16);
    };

    source.connect(processor);
    // Connect to a muted destination so onaudioprocess actually fires
    // in some browsers (Safari, certain Chrome versions).
    const silentGain = audioCtx.createGain();
    silentGain.gain.value = 0;
    processor.connect(silentGain);
    silentGain.connect(audioCtx.destination);

    startedAtRef.current = Date.now();
    setElapsedMs(0);
    tickRef.current = window.setInterval(() => {
      const ms = Date.now() - startedAtRef.current;
      setElapsedMs(ms);
      if (maxDurationMs && ms >= maxDurationMs) {
        onMaxDurationRef.current?.();
      }
    }, 250);

    setIsRecording(true);
    return true;
  }, [isRecording, maxDurationMs, requestPermission]);

  const stop = useCallback(async () => {
    if (!isRecording) return null;
    setIsRecording(false);

    const collected = chunksRef.current;
    chunksRef.current = [];
    cleanup();

    if (collected.length === 0) return null;
    return encodeWav(collected, targetSampleRate);
  }, [cleanup, isRecording]);

  return { isRecording, level, elapsedMs, start, stop, error };
}

function floatToInt16(float: Float32Array): Int16Array {
  const out = new Int16Array(float.length);
  for (let i = 0; i < float.length; i++) {
    const s = Math.max(-1, Math.min(1, float[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function downsample(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (toRate === fromRate) return input;
  if (toRate > fromRate) return input; // don't upsample
  const ratio = fromRate / toRate;
  const newLen = Math.floor(input.length / ratio);
  const out = new Float32Array(newLen);
  let idx = 0;
  let pos = 0;
  while (idx < newLen) {
    const next = Math.floor((idx + 1) * ratio);
    let sum = 0;
    let count = 0;
    for (let i = pos; i < next && i < input.length; i++) {
      sum += input[i];
      count++;
    }
    out[idx] = count > 0 ? sum / count : 0;
    pos = next;
    idx++;
  }
  return out;
}

function encodeWav(chunks: Int16Array[], sampleRate: number): Blob {
  let totalLen = 0;
  for (const c of chunks) totalLen += c.length;

  const buffer = new ArrayBuffer(44 + totalLen * 2);
  const view = new DataView(buffer);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++)
      view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + totalLen * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, totalLen * 2, true);

  let offset = 44;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      view.setInt16(offset, c[i], true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}
