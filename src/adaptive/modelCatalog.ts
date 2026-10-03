/**
 * Fase 1 — Catálogo estático de modelos.
 *
 * Nenhum provedor do gateway retorna preço hoje, então este catálogo é uma
 * tabela APROXIMADA mantida manualmente: custo por 1M tokens e camada de
 * latência. O objetivo é um ranking RELATIVO plausível para o Model Router,
 * não faturamento real.
 *
 * Fase 3 (Token & Cost Engine): `costPer1MTokens` (blend input+output) continua
 * sendo a fonte do RANKING (e é intocado); `inputCostPer1MTokens`/
 * `outputCostPer1MTokens` (opcionais) dão o split real de preço usado pelo
 * `costEstimator` para projetar custo de um request. Modelo sem split cai no
 * blend (fallback do estimador).
 *
 * Os nomes de `model` devem ser exatamente os usados no `ChatCompletionRequest`
 * (ex: Groq usa o prefixo do mantenedor, `openai/gpt-oss-120b`).
 */

import type { TaskCapability, TaskComplexity } from "./taskAnalyzer.js";

export type LatencyTier = "baixo" | "medio" | "alto";

export interface ModelEntry {
  /** Chave do registry: "openai" | "anthropic" | "gemini" | "groq". */
  provider: string;
  /** Nome exato usado no ChatCompletionRequest. */
  model: string;
  /** Complexidades para as quais o modelo é adequado. */
  complexitySuitability: TaskComplexity[];
  /** USD por 1M tokens (blend input+output, APROXIMADO) — fonte do RANKING. */
  costPer1MTokens: number;
  /** USD por 1M tokens de INPUT (aprox., público). Ausente → usa costPer1MTokens como blend. */
  inputCostPer1MTokens?: number;
  /** USD por 1M tokens de OUTPUT (aprox., público). Ausente → usa costPer1MTokens como blend. */
  outputCostPer1MTokens?: number;
  latencyTier: LatencyTier;
  capabilities: TaskCapability[];
  notes?: string;
}

export const MODEL_CATALOG: readonly ModelEntry[] = [
  // ── OpenAI ────────────────────────────────────────────────────────────
  {
    provider: "openai",
    model: "gpt-4o-mini",
    complexitySuitability: ["baixa", "media"],
    costPer1MTokens: 0.3,
    inputCostPer1MTokens: 0.15,
    outputCostPer1MTokens: 0.6,
    latencyTier: "baixo",
    capabilities: ["conversa", "geracao_codigo", "analise", "raciocinio"],
    notes: "Rápido e barato — boa escolha para tarefas simples/médias.",
  },
  {
    provider: "openai",
    model: "gpt-4.1-mini",
    complexitySuitability: ["baixa", "media"],
    costPer1MTokens: 0.4,
    inputCostPer1MTokens: 0.4,
    outputCostPer1MTokens: 1.6,
    latencyTier: "baixo",
    capabilities: ["conversa", "geracao_codigo", "analise", "raciocinio"],
    notes: "A geração mais nova do mini — eficiente e com boa janela de contexto.",
  },
  {
    provider: "openai",
    model: "gpt-4o",
    complexitySuitability: ["media", "alta"],
    costPer1MTokens: 5,
    inputCostPer1MTokens: 2.5,
    outputCostPer1MTokens: 10,
    latencyTier: "medio",
    capabilities: [
      "conversa",
      "geracao_codigo",
      "analise",
      "planejamento",
      "validacao",
      "raciocinio",
    ],
    notes: "Modelo geral robusto para tarefas complexas.",
  },
  {
    provider: "openai",
    model: "gpt-4.1",
    complexitySuitability: ["media", "alta"],
    costPer1MTokens: 4,
    inputCostPer1MTokens: 2,
    outputCostPer1MTokens: 8,
    latencyTier: "medio",
    capabilities: [
      "conversa",
      "geracao_codigo",
      "analise",
      "planejamento",
      "validacao",
      "raciocinio",
    ],
  },
  {
    provider: "openai",
    model: "o4-mini",
    complexitySuitability: ["media", "alta"],
    costPer1MTokens: 1.1,
    inputCostPer1MTokens: 1.1,
    outputCostPer1MTokens: 4.4,
    latencyTier: "medio",
    capabilities: [
      "analise",
      "raciocinio",
      "geracao_codigo",
      "validacao",
    ],
    notes: "Modelo de raciocínio — para tarefas que exigem pensar antes de responder.",
  },

  // ── Anthropic ─────────────────────────────────────────────────────────
  {
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    complexitySuitability: ["baixa", "media"],
    costPer1MTokens: 1,
    inputCostPer1MTokens: 1,
    outputCostPer1MTokens: 5,
    latencyTier: "baixo",
    capabilities: ["conversa", "geracao_codigo", "analise", "raciocinio"],
    notes: "Haiku — rápido e barato, para tarefas simples/médias.",
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    complexitySuitability: ["media", "alta"],
    costPer1MTokens: 8,
    inputCostPer1MTokens: 3,
    outputCostPer1MTokens: 15,
    latencyTier: "medio",
    capabilities: [
      "conversa",
      "geracao_codigo",
      "analise",
      "planejamento",
      "validacao",
      "raciocinio",
    ],
    notes: "Bom equilíbrio para código e análise.",
  },
  {
    provider: "anthropic",
    model: "claude-opus-4-8",
    complexitySuitability: ["alta"],
    costPer1MTokens: 20,
    inputCostPer1MTokens: 5,
    outputCostPer1MTokens: 25,
    latencyTier: "alto",
    capabilities: [
      "conversa",
      "geracao_codigo",
      "analise",
      "planejamento",
      "validacao",
      "raciocinio",
    ],
    notes: "Mais caro — reservado para tarefas de alta complexidade.",
  },

  // ── Google Gemini ─────────────────────────────────────────────────────
  // Nota: `gemini-2.5-flash-lite`, `gemini-2.0-flash` e `gemini-2.5-pro`
  // foram testados contra a API real (2026-08) e retornam 404 "no longer
  // available to new users" no POST /chat/completions — removidos do catálogo
  // para o router não eleger modelos que falham na execução. Só o Flash
  // executa de verdade na conta atual.
  {
    provider: "gemini",
    model: "gemini-2.5-flash",
    complexitySuitability: ["baixa", "media"],
    costPer1MTokens: 0.6,
    inputCostPer1MTokens: 0.3,
    outputCostPer1MTokens: 2.5,
    latencyTier: "baixo",
    capabilities: ["conversa", "geracao_codigo", "analise", "raciocinio"],
    notes: "Flash — barato, rápido, ideal para a maioria das tarefas.",
  },
  // `gemini-3.5-flash-lite` e `gemini-flash-latest` foram testados contra a
  // API real (2026-08) e executam com sucesso nesta conta — adicionados para
  // dar alternância de modelos dentro do provider Gemini.
  {
    provider: "gemini",
    model: "gemini-3.5-flash-lite",
    complexitySuitability: ["baixa", "media"],
    costPer1MTokens: 0.2,
    inputCostPer1MTokens: 0.1,
    outputCostPer1MTokens: 0.6,
    latencyTier: "baixo",
    capabilities: ["conversa", "raciocinio"],
    notes: "Flash Lite — o mais barato e rápido do Gemini; ideal para conversa simples.",
  },
  {
    provider: "gemini",
    model: "gemini-flash-latest",
    complexitySuitability: ["baixa", "media", "alta"],
    costPer1MTokens: 0.5,
    inputCostPer1MTokens: 0.25,
    outputCostPer1MTokens: 2.0,
    latencyTier: "baixo",
    capabilities: ["conversa", "geracao_codigo", "analise", "raciocinio"],
    notes: "Flash (latest) — alias para o Flash mais recente; bom equilíbrio.",
  },

  // ── Groq ──────────────────────────────────────────────────────────────
  // NOTA (30/08/2026): llama-3.1-8b-instant e llama-3.3-70b-versatile foram
  // descontinuados pela Groq (anúncio 17/06/2026, desligamento 16/08/2026)
  // — retornam 404 "model_not_found". Substitutos oficiais recomendados
  // pela própria Groq: openai/gpt-oss-20b e openai/gpt-oss-120b,
  // respectivamente. Ver https://console.groq.com/docs/deprecations
  {
    provider: "groq",
    model: "openai/gpt-oss-120b",
    complexitySuitability: ["baixa", "media", "alta"],
    costPer1MTokens: 0.375,
    inputCostPer1MTokens: 0.15,
    outputCostPer1MTokens: 0.6,
    latencyTier: "baixo",
    capabilities: [
      "conversa",
      "analise",
      "raciocinio",
      "geracao_codigo",
    ],
    notes: "Muito barato e rápido — substituto oficial do llama-3.3-70b-versatile (descontinuado).",
  },
  {
    provider: "groq",
    model: "openai/gpt-oss-20b",
    complexitySuitability: ["baixa", "media"],
    costPer1MTokens: 0.1875,
    inputCostPer1MTokens: 0.075,
    outputCostPer1MTokens: 0.3,
    latencyTier: "baixo",
    capabilities: ["conversa", "raciocinio"],
    notes: "O mais barato — substituto oficial do llama-3.1-8b-instant (descontinuado).",
  },
];

/**
 * Agrupa os modelos do catálogo por provider — FONTE ÚNICA de modelos.
 * `models.ts` (GET /v1/models) usa isto em vez de uma lista duplicada,
 * eliminando o drift de nomes entre o catálogo e o endpoint público.
 */
export function modelsByProvider(
  catalog: readonly ModelEntry[] = MODEL_CATALOG
): Map<string, string[]> {
  const byProvider = new Map<string, string[]>();
  for (const entry of catalog) {
    const list = byProvider.get(entry.provider) ?? [];
    list.push(entry.model);
    byProvider.set(entry.provider, list);
  }
  return byProvider;
}
