/**
 * Fase 1 — Model Router.
 *
 * `routeModel` escolhe o melhor modelo/provedor para uma tarefa com base em
 * critérios objetivos: capacidade (atende a tarefa?), adequação à
 * complexidade, custo e latência. Filosofia: "usar a quantidade mínima de
 * inteligência necessária para resolver corretamente a tarefa" — nunca
 * escolher por "marca".
 *
 * Determinístico e sem IO: a disponibilidade vem do registry de providers
 * (quem tem chave de API configurada), o custo/latência da tabela estática
 * `MODEL_CATALOG`. Em fases futuras (F3 — Token & Cost, F5 — Orchestrator),
 * `rankedCandidates` serve de cadeia de fallback: se o topo falhar em
 * execução, o runtime re-roteia para o próximo candidato.
 */

import type { ProviderAdapter } from "../providers/types.js";
import {
  type LatencyTier,
  type ModelEntry,
  MODEL_CATALOG,
} from "./modelCatalog.js";
// `ScoringWeights` e `DEFAULT_WEIGHTS` vivem em scoring.js — fonte única
// para evitar import circular (scoring importa nada de modelRouter; modelRouter
// consome scoring). Re-exportados aqui para compatibilidade com consumidores
// que importavam de modelRouter.js.
export {
  DEFAULT_WEIGHTS,
  type ScoringWeights,
} from "./scoring.js";
import { scoringWeightsFor, type ScoringWeights } from "./scoring.js";
import type { Strategy } from "./strategyEngine.js";
import type { TaskProfile } from "./taskAnalyzer.js";

export interface ScoredCandidate extends ModelEntry {
  score: number;
  capabilityScore: number;
  costScore: number;
  latencyScore: number;
  suitabilityScore: number;
  reason: string;
}

export type DecisionStatus =
  | "ok"
  | "nenhum_provedor_disponivel"
  | "nenhum_modelo_adequado"
  | "forca_invalida";

export interface ModelOverride {
  provider?: string;
  model?: string;
}

export interface ModelDecision {
  status: DecisionStatus;
  provider: string | null;
  model: string | null;
  score: number | null;
  costEstimate: number | null;
  latencyTier: LatencyTier | null;
  strategy: Strategy;
  reason: string;
  /** Candidatos ranqueados — cadeia de fallback para F3/F5. */
  rankedCandidates: ScoredCandidate[];
}

export interface RouteModelOptions {
  catalog?: readonly ModelEntry[];
  weights?: ScoringWeights;
  override?: ModelOverride;
}

const LATENCY_RANK: Record<LatencyTier, number> = {
  baixo: 1,
  medio: 2,
  alto: 3,
};

const LATENCY_SCORE: Record<LatencyTier, number> = {
  baixo: 1,
  medio: 0.6,
  alto: 0.3,
};

interface CandidateParts {
  entry: ModelEntry;
  capabilityScore: number;
  suitabilityScore: number;
  latencyScore: number;
}

/**
 * Ranqueia os candidatos disponíveis para a tarefa.
 * Determinístico — ordenação total (score, custo, latência, provider, modelo).
 */
export function rankCandidates(
  profile: TaskProfile,
  providers: Map<string, ProviderAdapter>,
  catalog: readonly ModelEntry[],
  weights: ScoringWeights
): ScoredCandidate[] {
  const availableProviders = new Set(providers.keys());

  const parts = catalog
    .filter((entry) => availableProviders.has(entry.provider))
    .map((entry) => scoreComponents(entry, profile));

  return assemble(parts, weights);
}

/** Calcula os componentes de score que não dependem do conjunto (custo à parte). */
function scoreComponents(
  entry: ModelEntry,
  profile: TaskProfile
): CandidateParts {
  const required = profile.capabilities;
  const matched = entry.capabilities.filter((cap) => required.includes(cap)).length;

  const capabilityScore =
    required.length === 0 ? 1 : matched / required.length;

  const suitabilityScore = entry.complexitySuitability.includes(
    profile.complexity
  )
    ? 1
    : 0.4;

  return {
    entry,
    capabilityScore,
    suitabilityScore,
    latencyScore: LATENCY_SCORE[entry.latencyTier],
  };
}

/**
 * Monta os candidatos finais: normaliza o custo com min-max dentro do
 * conjunto (mais barato = 1.0, mais caro = 0.0), calcula o score ponderado
 * e ordena deterministicamente.
 */
function assemble(
  parts: CandidateParts[],
  weights: ScoringWeights
): ScoredCandidate[] {
  const costs = parts.map((p) => p.entry.costPer1MTokens);
  const minCost = costs.length > 0 ? Math.min(...costs) : 0;
  const maxCost = costs.length > 0 ? Math.max(...costs) : 0;
  const costRange = maxCost - minCost;

  const scored = parts.map((p) => {
    const costScore =
      costRange === 0 ? 1 : (maxCost - p.entry.costPer1MTokens) / costRange;

    const score =
      weights.capability * p.capabilityScore +
      weights.suitability * p.suitabilityScore +
      weights.cost * costScore +
      weights.latency * p.latencyScore;

    return {
      ...p.entry,
      score,
      capabilityScore: p.capabilityScore,
      costScore,
      latencyScore: p.latencyScore,
      suitabilityScore: p.suitabilityScore,
      reason: buildCandidateReason(p.entry, p.capabilityScore, p.suitabilityScore),
    };
  });

  return scored.sort(compareCandidates);
}

function buildCandidateReason(
  entry: ModelEntry,
  capabilityScore: number,
  suitabilityScore: number
): string {
  return [
    `candidato ${entry.model} (${entry.provider})`,
    `capacidade ${capabilityScore.toFixed(2)}`,
    `adequação ${suitabilityScore.toFixed(2)}`,
    `custo $${entry.costPer1MTokens}/1M`,
    `latência ${entry.latencyTier}`,
  ].join(" | ");
}

/**
 * Comparador de ordenação total — garante ranking determinístico.
 * score desc → custo asc → latência asc → especialização asc → provider asc → model asc.
 *
 * "Especialização" = nº de faixas de complexidade que o modelo atende.
 * Em empate de score, preferimos o modelo que cobre MENOS faixas (mais
 * leve/especializado) — é o "mínimo de inteligência necessária" para a
 * tarefa, em vez do mais potente.
 */
function compareCandidates(a: ScoredCandidate, b: ScoredCandidate): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.costPer1MTokens !== b.costPer1MTokens) {
    return a.costPer1MTokens - b.costPer1MTokens;
  }
  const latDiff = LATENCY_RANK[a.latencyTier] - LATENCY_RANK[b.latencyTier];
  if (latDiff !== 0) return latDiff;
  const specDiff =
    a.complexitySuitability.length - b.complexitySuitability.length;
  if (specDiff !== 0) return specDiff;
  if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
  return a.model.localeCompare(b.model);
}

function emptyDecision(strategy: Strategy, reason: string): ModelDecision {
  return {
    status: "nenhum_provedor_disponivel",
    provider: null,
    model: null,
    score: null,
    costEstimate: null,
    latencyTier: null,
    strategy,
    reason,
    rankedCandidates: [],
  };
}

/**
 * Decide o melhor modelo para a tarefa.
 */
export function routeModel(
  profile: TaskProfile,
  strategy: Strategy,
  providers: Map<string, ProviderAdapter>,
  options: RouteModelOptions = {}
): ModelDecision {
  const catalog = options.catalog ?? MODEL_CATALOG;
  // Fase 2: pesos adaptativos por tarefa (quem os usa por padrão). Um
  // `options.weights` explícito continua vencendo (testes, F3+).
  const weights = options.weights ?? scoringWeightsFor(profile);
  const override = options.override ?? {};

  // Nenhum provedor configurado.
  if (providers.size === 0) {
    return emptyDecision(
      strategy,
      "Nenhum provedor configurado (sem chaves de API). Defina pelo menos uma chave no .env (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY ou GROQ_API_KEY)."
    );
  }

  // Restringe ao provider forçado, se houver.
  let filteredCatalog = catalog;
  if (override.provider) {
    filteredCatalog = catalog.filter(
      (entry) => entry.provider === override.provider
    );
  }

  // Modelo forçado deve existir no catálogo e o provider estar configurado.
  if (override.model) {
    const forced = filteredCatalog.find(
      (entry) => entry.model === override.model
    );
    const providerAvailable =
      !override.provider || providers.has(override.provider);

    if (!forced || !providerAvailable) {
      return {
        ...emptyDecision(strategy, ""),
        status: "forca_invalida",
        provider: override.provider ?? null,
        model: override.model,
        reason: `Modelo '${override.model}'${
          override.provider ? ` do provedor '${override.provider}'` : ""
        } não está no catálogo ou o provedor não está configurado.`,
      };
    }

    // Só o modelo forçado é candidato.
    filteredCatalog = [forced];
  }

  // Nenhuma entrada do catálogo cobre os provedores disponíveis.
  if (filteredCatalog.length === 0) {
    return {
      ...emptyDecision(strategy, "Nenhum modelo do catálogo atende aos provedores configurados."),
      status: "nenhum_modelo_adequado",
    };
  }

  const ranked = rankCandidates(profile, providers, filteredCatalog, weights);
  const best = ranked[0];

  if (!best) {
    return {
      ...emptyDecision(strategy, "Nenhum modelo atende à tarefa."),
      status: "nenhum_modelo_adequado",
    };
  }

  return {
    status: "ok",
    provider: best.provider,
    model: best.model,
    score: best.score,
    costEstimate: best.costPer1MTokens,
    latencyTier: best.latencyTier,
    strategy,
    reason: buildFinalReason(best, profile),
    rankedCandidates: ranked,
  };
}

function buildFinalReason(best: ScoredCandidate, profile: TaskProfile): string {
  const required = profile.capabilities;
  const matched = best.capabilities.filter((cap) => required.includes(cap));
  const capLabel =
    matched.length > 0 ? matched.join(", ") : "sem capacidades específicas";

  return `Escolhido ${best.model} (${best.provider}): score ${best.score.toFixed(
    3
  )}. Capaz para ${capLabel}, custo ~$${best.costPer1MTokens}/1M, latência ${
    best.latencyTier
  }, adequação ${profile.complexity}.`;
}
