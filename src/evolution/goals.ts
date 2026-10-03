/**
 * Fase 7 — Goal Generator.
 *
 * Transforma sinais de curiosidade em objetivos internos acionáveis.
 */

import { randomUUID } from "node:crypto";
import type { CuriositySignal } from "./types.js";
import type { TaskProfile } from "../adaptive/taskAnalyzer.js";
import type { Goal, GoalType } from "./types.js";

export type { Goal, GoalType };

/**
 * Gera objetivos a partir de um sinal de curiosidade.
 *
 * @param signal - Sinal de curiosidade detectado
 * @param profile - Perfil da tarefa atual
 * @returns Array de objetivos (máx 3)
 */
export function generateGoals(
  signal: CuriositySignal,
  _profile: TaskProfile
): Goal[] {
  if (!signal.shouldExplore) return [];

  const knowledge = signal.suggestedKnowledge;
  const priority = signal.priority;
  const baseGoals: Goal[] = [
    {
      id: `goal_improve_${Date.now()}_${randomUUID().slice(0, 8)}`,
      description: `Melhorar ${knowledge} — curiosidade: ${signal.reason}`,
      priority: Math.min(0.95, priority * 1.1),
      type: "improve",
    },
    {
      id: `goal_learn_${Date.now()}_${randomUUID().slice(0, 8)}`,
      description: `Aprofundar conhecimento sobre ${knowledge}`,
      priority: 0.7,
      type: "learn",
    },
    {
      id: `goal_optimize_${Date.now()}_${randomUUID().slice(0, 8)}`,
      description: `Reduzir erros recorrentes em ${knowledge}`,
      priority: priority * 0.8,
      type: "optimize",
    },
  ];

  return baseGoals.slice(0, 3);
}