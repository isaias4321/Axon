import { createOpenAiCompatibleAdapter } from "./openAiCompatible.js";
import type { ProviderAdapter } from "./types.js";

/**
 * O Google expõe um endpoint compatível com o formato de chat completions
 * da OpenAI especificamente para facilitar a migração de projetos
 * existentes — é isso que usamos aqui, em vez do formato nativo da API
 * do Gemini (`generateContent`), para reaproveitar a mesma lógica de
 * request/response/streaming dos outros provedores.
 * Docs: https://ai.google.dev/gemini-api/docs/openai
 */
const GEMINI_BASE_URL =
  process.env["GEMINI_BASE_URL"] ?? "https://generativelanguage.googleapis.com/v1beta/openai";

export function createGeminiAdapter(apiKey: string, requestTimeoutMs = 30_000): ProviderAdapter {
  return createOpenAiCompatibleAdapter({ name: "gemini", baseUrl: GEMINI_BASE_URL, apiKey, requestTimeoutMs });
}
