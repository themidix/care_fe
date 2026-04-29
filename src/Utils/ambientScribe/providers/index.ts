import careConfig from "@careConfig";

import { assemblyaiProvider } from "@/Utils/ambientScribe/providers/assemblyai";
import { openaiProvider } from "@/Utils/ambientScribe/providers/openai";
import type { AsrLlmProvider } from "@/Utils/ambientScribe/providers/types";

export type ProviderName = AsrLlmProvider["name"];

const PROVIDERS: Record<ProviderName, AsrLlmProvider> = {
  assemblyai: assemblyaiProvider,
  openai: openaiProvider,
};

/**
 * Resolve the active scribe provider. Defaults to whatever is configured in
 * `careConfig.ambientScribe.provider`, falling back to `openai` when the
 * configured value is missing or unknown.
 */
export function getProvider(name?: ProviderName): AsrLlmProvider {
  const configured =
    name ?? (careConfig.ambientScribe.provider as ProviderName);
  return PROVIDERS[configured] ?? PROVIDERS.openai;
}

/**
 * The matching API key for a provider, sourced from careConfig.
 */
export function getProviderApiKey(
  provider: AsrLlmProvider,
): string | undefined {
  switch (provider.name) {
    case "assemblyai":
      return careConfig.ambientScribe.assemblyAIApiKey;
    case "openai":
      return careConfig.ambientScribe.openAIApiKey;
  }
}

export type { AsrLlmProvider };
