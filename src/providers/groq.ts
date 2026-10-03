import { createOpenAiCompatibleAdapter } from "./openAiCompatible.js";
import type { ProviderAdapter } from "./types.js";

/**
 * O Groq expõe um endpoint compatível com o formato de chat completions
 * da OpenAI. Modelos costumam ser identificados com o prefixo do
 * mantenedor original, ex: "llama-3.3-70b-versatile", "openai/gpt-oss-120b".
 * Docs: https://console.groq.com/docs/openai
 *
 * Nota: o Groq não oferece endpoint de embeddings — este adapter cobre
 * apenas chat completions, que é o que este gateway expõe.
 */
const GROQ_BASE_URL = process.env["GROQ_BASE_URL"] ?? "https://api.groq.com/openai/v1";

export function createGroqAdapter(apiKey: string, requestTimeoutMs = 30_000): ProviderAdapter {
  return createOpenAiCompatibleAdapter({ name: "groq", baseUrl: GROQ_BASE_URL, apiKey, requestTimeoutMs });
}
