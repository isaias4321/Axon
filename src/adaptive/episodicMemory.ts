/**
 * Fase 6 — Episodic Memory & Lessons Learned.
 *
 * Ao final de cada execução autônoma, persiste um episódio completo:
 * Task → Initial Plan → Steps (Action/Observation/Validation/Result) →
 * Corrections → Replans → Final Result → Failure Info → Lessons Learned.
 *
 * NÃO armazena apenas a resposta final — preserva a EXPERIÊNCIA da execução.
 */

import {
  episodesRepo,
  stepsRepo,
  validationsRepo,
  memoriesRepo,
} from "../lib/db/index.js";
import type { Episode, Step, Validation, Memory } from "../lib/db/repos.js";
import type {
  Plan,
  PlanStep,
  Observation,
  ValidationResult,
  CorrectionRecord,
  ReplanRecord,
  TerminationReason,
  Decision,
} from "./types.js";

export interface EpisodeData {
  episodeId: number;
  task: string;
  strategy: "autonomous";
  initialPlan: Plan;
  finalPlan: Plan;
  steps: Array<{
    step: PlanStep;
    observation: Observation;
    validation: ValidationResult;
    decision: Decision;
  }>;
  corrections: CorrectionRecord[];
  replans: ReplanRecord[];
  finalResult: string | null;
  terminationReason: TerminationReason;
  totalIterations: number;
  totalCostUsd: number | null;
  totalDurationMs: number;
  totalTokens: number;
}

export interface LessonsLearned {
  insights: string[];
  failureReasons: string[];
  successfulApproaches: string[];
  avoidedMistakes: string[];
  recommendations: string[];
}

/**
 * Salva um episódio completo no SQLite.
 */
export function saveEpisode(data: EpisodeData, _sessionId: string): void {
  try {
    // Mapeia "max_cost" para "budget_exceeded" (DB não tem max_cost)
    const dbStatus = data.terminationReason === "max_cost"
      ? "budget_exceeded" as const
      : data.terminationReason;

    // 1. Atualiza o episódio
    episodesRepo.complete(
      data.episodeId,
      data.finalResult ?? "Nenhum resultado final.",
      dbStatus,
      data.totalIterations,
      data.totalCostUsd,
      data.totalDurationMs
    );

    // 2. Salva steps detalhados
    for (const stepData of data.steps) {
      const iterationNum = typeof stepData.decision.metadata.iteration === "number"
        ? stepData.decision.metadata.iteration
        : 0;
      const stepRow = stepsRepo.create({
        episode_id: data.episodeId,
        iteration: iterationNum,
        step_type: stepData.validation.passed ? "execute" : "correct",
        action_json: JSON.stringify({
          action: stepData.step.description,
          objective: stepData.step.objective,
          capability: stepData.step.capability,
        }),
        observation_json: JSON.stringify(stepData.observation),
        validation_json: JSON.stringify(stepData.validation),
        decision: stepData.decision.action,
        cost_usd: stepData.validation.costUsd ?? null,
        duration_ms: stepData.observation.durationMs,
      });

      validationsRepo.create({
        step_id: stepRow.id,
        validator_type: stepData.validation.validatorType,
        passed: stepData.validation.passed,
        confidence: stepData.validation.confidence,
        issues_json: JSON.stringify(stepData.validation.issues),
        suggested_correction: stepData.validation.suggestedCorrection,
      });
    }

    // 3. Salva memória de longo prazo (se sucesso)
    if (data.terminationReason === "success") {
      const lessons = generateLessonsLearned(data);

      memoriesRepo.create({
        type: "episodic",
        episode_id: data.episodeId,
        content_json: JSON.stringify({
          task: data.task,
          finalResult: data.finalResult,
          iterations: data.totalIterations,
          insights: lessons.insights.join("; "),
          lessons_learned: lessons.insights,
        }),
        embedding_text: data.task,
        tags_json: JSON.stringify([data.initialPlan.steps[0]?.capability ?? "geral"]),
      });

      // Salva também como 'procedural' se houve abordagem bem-sucedida
      if (lessons.successfulApproaches.length > 0) {
        memoriesRepo.create({
          type: "procedural",
          episode_id: data.episodeId,
          content_json: JSON.stringify({
            task_type: data.initialPlan.steps[0]?.capability ?? "geral",
            approaches: lessons.successfulApproaches,
          }),
          embedding_text: data.task,
          tags_json: JSON.stringify([data.initialPlan.steps[0]?.capability ?? "geral"]),
          relevance_score: 1.0,
        });
      }
    }

    // 4. Salva memória de falha (se falhou)
    if (data.terminationReason === "failure" || data.terminationReason === "no_progress") {
      const lessons = generateLessonsLearned(data);

      memoriesRepo.create({
        type: "episodic",
        episode_id: data.episodeId,
        content_json: JSON.stringify({
          task: data.task,
          failure_reason: data.terminationReason,
          failure_details: lessons.failureReasons.join("; "),
          avoided_next_time: lessons.avoidedMistakes,
        }),
        embedding_text: data.task,
        tags_json: JSON.stringify(["failure", data.initialPlan.steps[0]?.capability ?? "geral"]),
        relevance_score: 0.5,
      });
    }
  } catch {
    // FALHA ABERTA: não interrompe a execução se a memória falhar
  }
}

/**
 * Gera Lessons Learned a partir dos dados do episódio.
 */
export function generateLessonsLearned(data: EpisodeData): LessonsLearned {
  const insights: string[] = [];
  const failureReasons: string[] = [];
  const successfulApproaches: string[] = [];
  const avoidedMistakes: string[] = [];
  const recommendations: string[] = [];

  // Análise de steps
  const completedSteps = data.steps.filter((s) => s.validation.passed);
  const failedSteps = data.steps.filter((s) => !s.validation.passed);

  // Insights de sucesso
  if (completedSteps.length > 0) {
    insights.push(`${completedSteps.length} etapa(s) concluída(s) com sucesso`);
    for (const step of completedSteps.slice(0, 3)) {
      successfulApproaches.push(
        `Etapa '${step.step.description}' funcionou com ${step.step.attempts} tentativa(s)`
      );
    }
  }

  // Razões de falha
  for (const step of failedSteps.slice(0, 3)) {
    if (step.validation.issues.length > 0) {
      failureReasons.push(
        `Etapa '${step.step.description}': ${step.validation.issues.join("; ")}`
      );
    }
  }

  // Erros evitados
  for (const correction of data.corrections.slice(0, 3)) {
    avoidedMistakes.push(
      `Corrigido na etapa '${correction.stepId}': ${correction.reason}`
    );
  }

  // Recomendações baseadas em replans
  if (data.replans.length > 0) {
    recommendations.push(
      `Replanejamento necessário ${data.replans.length}x — considere plano mais robusto inicialmente`
    );
  }

  // Recomendações baseadas em terminReason
  switch (data.terminationReason) {
    case "no_progress":
      recommendations.push("Detectado falta de progresso — revise a estratégia ou ferramentas");
      break;
    case "max_iterations":
      recommendations.push("Aumente maxIterations ou simplifique a tarefa");
      break;
    case "max_cost":
      recommendations.push("Aumente maxCostUsd ou use modelo mais barato");
      break;
    case "timeout":
      recommendations.push("Aumente maxDurationMs ou otimize etapas");
      break;
    case "success":
      recommendations.push("Abordagem funcionou — reutilize para tarefas similares");
      break;
  }

  return {
    insights,
    failureReasons,
    successfulApproaches,
    avoidedMistakes,
    recommendations,
  };
}

/**
 * Recupera um episódio completo para auditoria.
 */
export function getEpisode(episodeId: number): {
  episode: Episode | null;
  steps: Step[];
  validations: Validation[];
  memories: Memory[];
} {
  try {
    const episode = episodesRepo.getById(episodeId);
    const steps = stepsRepo.getByEpisode(episodeId);
    const validations: Validation[] = [];

    for (const step of steps) {
      validations.push(...validationsRepo.getByStep(step.id));
    }

    const memories = memoriesRepo.getByEpisode(episodeId);

    return { episode, steps, validations, memories };
  } catch {
    return { episode: null, steps: [], validations: [], memories: [] };
  }
}

/**
 * Formata um episódio para exibição humana (não exponha dados sensíveis).
 */
export function formatEpisodeForAudit(episodeId: number): string {
  const { episode, steps, validations } = getEpisode(episodeId);

  if (!episode) {
    return "Episódio não encontrado";
  }

  const lines: string[] = [
    `Episódio #${episode.id}`,
    `Task: ${episode.task.substring(0, 100)}...`,
    `Status: ${episode.final_status}`,
    `Iterações: ${episode.total_iterations}`,
    `Custo: $${episode.total_cost_usd?.toFixed(4) ?? "N/A"}`,
    `Duração: ${episode.total_duration_ms ?? 0}ms`,
    `Passos: ${steps.length}`,
    "",
    "Passos:",
  ];

  steps.forEach((step, i) => {
    const validation = validations.find((v) => v.step_id === step.id);
    lines.push(
      `  ${i + 1}. [${step.step_type}] ${step.decision} ` +
      `(validation: ${validation?.passed ? "pass" : "fail"})`
    );
  });

  return lines.join("\n");
}

