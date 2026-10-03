import type { Env } from "../config.js";
import { createAnthropicAdapter } from "./anthropic.js";
import { createGeminiAdapter } from "./gemini.js";
import { createGroqAdapter } from "./groq.js";
import { createOpenAiAdapter } from "./openai.js";
import type { ProviderAdapter } from "./types.js";

export function buildProviderRegistry(env: Env): Map<string, ProviderAdapter> {
  const registry = new Map<string, ProviderAdapter>();

  if (env.OPENAI_API_KEY) {
    registry.set("openai", createOpenAiAdapter(env.OPENAI_API_KEY));
  }
  if (env.ANTHROPIC_API_KEY) {
    registry.set("anthropic", createAnthropicAdapter(env.ANTHROPIC_API_KEY));
  }
  if (env.GEMINI_API_KEY) {
    registry.set("gemini", createGeminiAdapter(env.GEMINI_API_KEY));
  }
  if (env.GROQ_API_KEY) {
    registry.set("groq", createGroqAdapter(env.GROQ_API_KEY));
  }

  return registry;
}
