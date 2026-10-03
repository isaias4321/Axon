/**
 * Fase 1 & 6 — Adaptive Core: Strategy Engine.
 *
 * `decideStrategy` mapeia um `TaskProfile` para uma estratégia de execução:
 * - `single_agent`: tarefa simples o suficiente para um único passo.
 * - `multi_agent`: tarefa complexa com múltiplas capacidades — orquestrada na F5.
 * - `autonomous`: tarefas abertas com gatilho explícito de autonomia ("autônomo", "autonomia", "modo autônomo").
 * - `no_execution`: tarefa ambígua demais para executar.
 *
 * Determinístico e sem IO. Preserva integralmente F1–F5.
 */

import type { TaskProfile } from "./taskAnalyzer.js";
import { detectToolIntent, isCapabilityQuestion } from "./taskAnalyzer.js";

export type Strategy = "single_agent" | "multi_agent" | "autonomous" | "no_execution";

export interface StrategyDecision {
  strategy: Strategy;
  reason: string;
}

export function decideStrategy(profile: TaskProfile): StrategyDecision {
  if (profile.wordCount < 2) {
    return {
      strategy: "no_execution",
      reason: `Tarefa ambígua (apenas ${profile.wordCount} palavra(s)). Peça mais detalhes sobre o que deseja.`,
    };
  }

  if (isCapabilityQuestion(profile.text)) {
    return {
      strategy: "single_agent",
      reason: "Pergunta sobre capacidades do agente — resposta direta em linguagem natural.",
    };
  }

  // Se o texto contiver gatilhos explícitos de autonomia (ex: "autônomo", "autonomia", "modo autônomo")
  const hasAutonomousTrigger = /\b(autônomo|autonomo|autonomia|agente autônomo|modo autônomo)\b/i.test(profile.text);

  if (hasAutonomousTrigger) {
    return {
      strategy: "autonomous",
      reason: `Tarefa com solicitação explícita de autonomia — exige loop autônomo adaptativo (Fase 6).`,
    };
  }
// Tarefas que exigem uma AÇÃO REAL (criar/ler/escrever arquivo, executar um
  // comando, requisitar uma URL) — o único fluxo que EXECUTA tools de verdade(
  // o loop autônomo, Fase 6, usa o ToolRegistry). Roteamos para ele para
  // que o agente EXECUTE a ação concreta, em vez de apenas responder com texto.

  const toolIntent = detectToolIntent(profile.text);
  if (toolIntent) {
    return {
      strategy: "autonomous",
      reason: `Tarefa exige uma ação real (${toolIntent}) — fluxo autônomo com execução de ferramentas( Fase 6).`,
    };
  }

  if (profile.complexity === "alta" && profile.capabilities.length >= 2) {
    return {
      strategy: "multi_agent",
      reason: `Tarefa complexa (${profile.complexity}) com ${profile.capabilities.length} capacidades (${profile.capabilities.join(
        ", "
      )}) — exige orquestração multiagente.`,
    };
  }

  return {
    strategy: "single_agent",
    reason: `Tarefa de complexidade ${profile.complexity} — resolvível por um agente único.`,
  };
}
/**
 * Deteta se a tarefa pede uma ação concreta executável via Tool Registry
 * (filesystem, shell ou http). Ordem determinística: arquivo → comando → URL.
 * É o elo que conecta o Tool Registry (F6) ao fluxo REAL do agente — sem
 * ele, tarefas que exigem ferramenta cairiam em `single_agent`, que só
 * responde com texto, sem executar nada. Movida para `taskAnalyzer.ts`
 * (fonte única de verdade, reutilizada também pelo Planner e pelo loop
 * autônomo) — reexportada aqui por compatibilidade com quem já importa
 * `detectToolIntent` a partir deste módulo.
 */
export { detectToolIntent } from "./taskAnalyzer.js";
