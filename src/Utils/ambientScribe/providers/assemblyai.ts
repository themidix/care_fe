import {
  STREAMING_SAMPLE_RATE,
  lemurExtract,
  pollTranscript,
  requestBatchTranscript,
  uploadAudio,
} from "@/Utils/ambientScribe/assemblyai";
import type {
  AsrLlmProvider,
  ScribeBatchTranscript,
} from "@/Utils/ambientScribe/providers/types";
import { useAssemblyAIStreaming } from "@/Utils/ambientScribe/useAssemblyAIStreaming";

/**
 * AssemblyAI provider — Universal-3 Pro Streaming + Medical Mode for live,
 * Universal-3 Pro batch with diarization on stop, and LeMUR (Claude Sonnet 4)
 * for extraction. English-only (Malayalam not supported).
 */
export const assemblyaiProvider: AsrLlmProvider = {
  name: "assemblyai",
  audioFormat: { sampleRate: STREAMING_SAMPLE_RATE },

  useStreaming: (apiKey) => useAssemblyAIStreaming(apiKey),

  async transcribeBatch(apiKey, audio, options) {
    const uploadUrl = await uploadAudio(apiKey, audio);
    const id = await requestBatchTranscript(apiKey, uploadUrl);
    const transcript = await pollTranscript(apiKey, id, {
      intervalMs: 3000,
      signal: options?.signal,
    });
    // AssemblyAI's BatchTranscript already matches our ScribeBatchTranscript
    // shape (id/status/text/utterances/error).
    return transcript as unknown as ScribeBatchTranscript;
  },

  async extract(apiKey, text, questions) {
    return lemurExtract(apiKey, text, questions);
  },
};
