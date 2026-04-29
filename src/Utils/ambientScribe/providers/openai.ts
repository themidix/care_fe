import careConfig from "@careConfig";

import {
  OPENAI_SAMPLE_RATE,
  gptExtract,
  gptExtractStream,
  transcribeBatchDiarized,
} from "@/Utils/ambientScribe/openai";
import type { AsrLlmProvider } from "@/Utils/ambientScribe/providers/types";
import { useOpenAIRealtimeStreaming } from "@/Utils/ambientScribe/useOpenAIRealtimeStreaming";

/**
 * OpenAI provider — Realtime API (`gpt-4o-transcribe`) for live partials,
 * `gpt-4o-transcribe-diarize` for the post-stop diarized batch pass, and
 * `gpt-4o-mini` (Chat Completions, JSON mode) for structured extraction.
 *
 * Supports Malayalam and other Indic languages via the `language` and
 * `prompt` knobs in `careConfig.ambientScribe`.
 */
export const openaiProvider: AsrLlmProvider = {
  name: "openai",
  audioFormat: { sampleRate: OPENAI_SAMPLE_RATE },

  useStreaming: (apiKey) =>
    useOpenAIRealtimeStreaming(apiKey, {
      language: careConfig.ambientScribe.language,
      prompt: careConfig.ambientScribe.medicalKeywordsPrompt,
    }),

  async transcribeBatch(apiKey, audio, options) {
    const result = await transcribeBatchDiarized(apiKey, audio, {
      language: careConfig.ambientScribe.language,
      signal: options?.signal,
    });
    return {
      status: "completed",
      text: result.text,
      utterances: result.utterances,
    };
  },

  async extract(apiKey, text, questions, options) {
    return gptExtract(apiKey, text, questions, {
      languageHint: options?.languageHint ?? careConfig.ambientScribe.language,
      keywordsHint:
        options?.keywordsHint ?? careConfig.ambientScribe.medicalKeywordsPrompt,
    });
  },

  async extractStream(apiKey, text, questions, onProgress, options) {
    return gptExtractStream(apiKey, text, questions, onProgress, {
      languageHint: options?.languageHint ?? careConfig.ambientScribe.language,
      keywordsHint:
        options?.keywordsHint ?? careConfig.ambientScribe.medicalKeywordsPrompt,
      signal: options?.signal,
    });
  },
};
