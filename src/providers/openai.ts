import { createOpenAiCompatibleAdapter } from "./openAiCompatible.js";
import type { ProviderAdapter } from "./types.js";

const OPENAI_BASE_URL = process.env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1";

export function createOpenAiAdapter(apiKey: string): ProviderAdapter {
  return createOpenAiCompatibleAdapter({ name: "openai", baseUrl: OPENAI_BASE_URL, apiKey });
}
