/**
 * Fase 7 — Evolution Loader.
 *
 * Fecha o feedback loop: LÊ do SQLite o histórico evolutivo persistido por
 * execuções anteriores e o transforma em um `EvolutionContext` que o
 * autonomous loop usa para influenciar decisões reais.
 *
 * Ciclo: Experiência → Memória → Reflexão → Aprendizado → Mudança → Nova experiência.
 *
 * Fail-open: qualquer falha de leitura retorna um contexto vazio — nunca
 * derruba o loop autônomo.
 */

import type { SkillsState, StrategyState } from "./types.js";
import { skillsRepo, strategyScoresRepo, curiositySignalsRepo, goalsRepo, metabolismRepo, reflectionsRepo } from "../lib/db/index.js";

/**
 * Contexto evolutivo carregado do SQLite antes de uma nova execução.
 * É o "aprendizado" que influencia decisões:
 * - strategyHistory: estratégias com histórico (successRate/custo) para re-priorizar
 * - skills: confiança/sucesso por capacidade para sinalizar melhoria
 * - recurringErrors: erros recorrentes para alimentar curiosidade
 * - energyHistory: histórico de custo/energia para escolher tier de modelo
 * - priorReflections: lições de execuções anteriores
 * - priorGoals: objetivos internos ainda ativos
 */
export interface EvolutionContext {
  strategyHistory: Array<{ strategy: string; successRate: number; avgCost: number; avgTime: number; sampleCount: number }>;
  skills: Array<{ name: string; successRate: number; usageCount: number; confidence: number }>;
  recurringErrors: string[];
  energyHistory: Array<{ budgetAvailable: number; efficiencyScore: number; riskLevel: string }>;
  priorReflections: string[];
  priorGoals: Array<{ description: string; type: string; achieved: boolean }>;
  loadedAt: number;
}

/** Cria um contexto vazio (fallback / fail-open). */
export function emptyEvolutionContext(): EvolutionContext {
  return {
    strategyHistory: [],
    skills: [],
    recurringErrors: [],
    energyHistory: [],
    priorReflections: [],
    priorGoals: [],
    loadedAt: Date.now(),
  };
}

/**
 * Carrega do SQLite o histórico evolutivo de uma sessão.
 * Nunca lança — em qualquer erro retorna contexto vazio.
 */
export function loadEvolutionContext(sessionId: string): EvolutionContext {
  try {
    const skills = skillsRepo.getBySession(sessionId, 100);
    const strategies = strategyScoresRepo.getBySessionId(sessionId, 100);
    const curiosities = curiositySignalsRepo.getBySession(sessionId, 100);
    const metabolism = metabolismRepo.getRecent(sessionId, 50);
    const reflections = reflectionsRepo.getBySession(sessionId, 50);
    const goals = goalsRepo.getBySession(sessionId, 50);

    // Erros recorrentes: sinais de curiosidade que acusaram erro recorrente
    const recurringErrors = curiosities
      .filter((c) => c.should_explore === 1 && /recorrente/i.test(c.reason))
      .map((c) => c.reason);

    return {
      strategyHistory: strategies.map((s) => ({
        strategy: s.strategy,
        successRate: s.success_rate,
        avgCost: s.avg_cost,
        avgTime: s.avg_time,
        sampleCount: s.sample_count,
      })),
      skills: skills.map((s) => ({
        name: s.name,
        successRate: s.success_rate,
        usageCount: s.usage_count,
        confidence: s.confidence,
      })),
      recurringErrors,
      energyHistory: metabolism.map((m) => ({
        budgetAvailable: m.budget_available,
        efficiencyScore: m.efficiency_score,
        riskLevel: m.risk_level,
      })),
      priorReflections: reflections.map((r) => r.improvement_suggestion ?? "").filter(Boolean),
      priorGoals: goals.map((g) => ({ description: g.description, type: g.type, achieved: g.achieved === 1 })),
      loadedAt: Date.now(),
    };
  } catch {
    // Fail-open: nunca derruba o loop
    return emptyEvolutionContext();
  }
}

/**
 * Aplica o histórico para influenciar a escolha de modelo/tier.
 * Retorna um ajuste de custo: se energia histórica está baixa → preferir barato;
 * se eficiência histórica é alta → permitir um pouco mais.
 */
export function influenceModelTier(
  context: EvolutionContext,
  currentTier: "cheap" | "balanced" | "expensive"
): { tier: "cheap" | "balanced" | "expensive"; reason: string } {
  if (context.energyHistory.length === 0) {
    return { tier: currentTier, reason: "Sem histórico de energia" };
  }

  // Última snapshot de energia
  const last = context.energyHistory[context.energyHistory.length - 1]!;
  if (last.riskLevel === "high" && last.budgetAvailable < 0.5) {
    return { tier: "cheap", reason: `Histórico mostra orçamento crítico (${last.budgetAvailable.toFixed(4)} USD restantes)` };
  }
  if (last.efficiencyScore >= 1.0) {
    return { tier: "balanced", reason: "Histórico mostra alta eficiência" };
  }
  return { tier: currentTier, reason: "Histórico sem mudança de tier" };
}

/**
 * Aplica o histórico para re-priorizar estratégias.
 * Estratégias com successRate baixo são despriorizadas.
 * Retorna uma lista priorizada (melhor primeiro).
 */
export function prioritizeStrategies(
  context: EvolutionContext,
  minSamples = 2
): Array<{ strategy: string; priority: number }> {
  const eligible = context.strategyHistory.filter((s) => s.sampleCount >= minSamples);
  if (eligible.length === 0) return [];

  // Score = successRate * 0.7 - avgCost * 0.2 - avgTime * 0.0001
  return eligible
    .map((s) => ({
      strategy: s.strategy,
      priority: s.successRate * 0.7 - s.avgCost * 0.2 - s.avgTime * 0.0001,
    }))
    .sort((a, b) => b.priority - a.priority);
}

/**
 * Identifica capacidades fracas no histórico (successRate baixo) que precisam
 * de melhoria — alimenta curiosidade/objetivos.
 */
export function weakCapabilities(context: EvolutionContext, threshold = 0.5): string[] {
  return context.skills
    .filter((s) => s.usageCount >= 3 && s.successRate < threshold)
    .map((s) => s.name);
}

// Re-export dos estados para carregar diretamente no loop
export type { SkillsState, StrategyState };
