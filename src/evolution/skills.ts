/**
 * Fase 7 — Skill Acquisition.
 *
 * Rastreia taxa de sucesso e confiança por capacidade.
 * Melhora escolhas futuras baseadas no histórico.
 */

import type { SkillsState, Skill, SkillEntry } from "./types.js";
import type { TaskCapability } from "../adaptive/taskAnalyzer.js";

export type { SkillsState, Skill, SkillEntry };

/** Cria estado inicial de skills. */
export function createSkillsState(): SkillsState {
  return { byName: new Map<string, SkillEntry>() };
}

/** Retorna lista de skills derivadas (com successRate e confidence calculados). */
export function getSkills(state: SkillsState): Skill[] {
  return Array.from(state.byName.values()).map((entry) => ({
    name: entry.name,
    description: entry.description,
    successRate: entry.usageCount > 0 ? entry.successes / entry.usageCount : 0,
    usageCount: entry.usageCount,
    confidence: 1 / (1 + Math.exp(-entry.usageCount + 3)),
  }));
}

/**
 * Atualiza uma skill após um ciclo.
 * success é baseado em validation.passed.
 */
export function updateSkill(
  state: SkillsState,
  capability: TaskCapability,
  success: boolean,
  description: string
): void {
  const entry = state.byName.get(capability) ?? {
    name: capability,
    description,
    successes: 0,
    failures: 0,
    usageCount: 0,
    lastUpdated: 0,
  };
  entry.usageCount += 1;
  if (success) entry.successes += 1; else entry.failures += 1;
  entry.lastUpdated = Date.now();
  state.byName.set(capability, entry);
}

/**
 * Retorna a skill com menor confiança para uma capability.
 * Retorna null se não existir.
 */
export function leastConfidentSkill(
  state: SkillsState,
  capability: TaskCapability
): Skill | null {
  const skills = getSkills(state).filter((s) => s.name === capability);
  if (skills.length === 0) return null;
  return skills.reduce((least, current) =>
    current.confidence < least.confidence ? current : least
  );
}