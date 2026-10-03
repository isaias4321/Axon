/**
 * Fase 6 — Decision Engine & Replanning.
 *
 * O Decision Engine analisa o estado após observação + validação e decide:
 * - CONTINUE: próxima etapa do plano
 * - CORRECT: repetir esta etapa com correção
 * - REPLAN: gerar novo plano (reorganizar/repor etapas restantes)
 * - FINISH: terminar com sucesso ou falha
 *
 * O replanning é REAL: substitui/reorganiza etapas restantes, não apenas
 * adiciona uma etapa no final.
 */

import type { LLMRunner } from "./runtime.js";
import type { ProviderAdapter } from "../providers/types.js";
import type { TaskProfile } from "./taskAnalyzer.js";
import type {
  Plan,
  PlanStep,
  Observation,
  ValidationResult,
  Decision,
  CorrectionRecord,
  ReplanRecord,
} from "./types.js";
import type { RetrievedMemory } from "./memoryRetrieval.js";
import { planTask } from "./planner.js";

export interface DecisionContext {
  step: PlanStep;
  observation: Observation;
  validation: ValidationResult;
  plan: Plan;
  profile: TaskProfile;
  consecutiveFailures: number;
  noProgressThreshold: number;
  enableCorrection: boolean;
  enableReplanning: boolean;
  retrievedMemory: RetrievedMemory[];
}

/**
 * Decision Engine — decide a próxima ação.
 */
export function decideNextAction(context: DecisionContext): Decision {
  const { step, validation, plan, consecutiveFailures, noProgressThreshold } = context;

  // 1. Sem progresso detectado
  if (consecutiveFailures >= noProgressThreshold) {
    return {
      action: "finish",
      reason: `no_progress: ${consecutiveFailures} falhas consecutivas na etapa '${step.id}'`,
      confidence: 0.95,
      metadata: {
        consecutiveFailures,
        stepId: step.id,
        terminationReason: "no_progress",
      },
    };
  }

  // 2. Validação falhou
  if (!validation.passed) {
    // Tentar correction se habilitado e etapa não excedeu maxAttempts
    if (context.enableCorrection && step.attempts < step.maxAttempts) {
      return {
        action: "correct",
        reason: `validation_failed: ${validation.issues.join("; ")}`,
        confidence: validation.confidence,
        metadata: {
          stepId: step.id,
          issues: validation.issues,
          suggestedCorrection: validation.suggestedCorrection,
        },
      };
    }

    // Tentar replanning se habilitado
    if (context.enableReplanning) {
      return {
        action: "replan",
        reason: `step_failed_after_attempts: etapa '${step.id}' falhou ${step.attempts}x`,
        confidence: 0.8,
        metadata: {
          stepId: step.id,
          attempts: step.attempts,
        },
      };
    }

    // Senão → finish failure
    return {
      action: "finish",
      reason: `step_failed: etapa '${step.id}' não pode ser completada`,
      confidence: 0.9,
      metadata: {
        stepId: step.id,
        terminationReason: "failure",
      },
    };
  }

  // 3. Validação passou → continuar
  // Verificar se há próxima etapa no plano
  const nextStep = findNextStep(plan, step.id);

  if (nextStep) {
    return {
      action: "continue",
      reason: `step_completed: etapa '${step.id}' validada com sucesso`,
      confidence: validation.confidence,
      metadata: {
        stepId: step.id,
        nextStepId: nextStep.id,
      },
    };
  }

  // 4. Não há mais etapas → finish success
  return {
    action: "finish",
    reason: "all_steps_completed: todas as etapas concluídas e validadas",
    confidence: 0.95,
    metadata: {
      terminationReason: "success",
    },
  };
}

/**
 * Encontra a próxima etapa do plano (considerando dependências).
 */
function findNextStep(plan: Plan, completedStepId: string): PlanStep | null {
  // Marca a etapa atual como completed
  const completedStep = plan.steps.find((s) => s.id === completedStepId);
  if (completedStep) {
    completedStep.status = "completed";
  }

  // Procura a primeira etapa pending cujas dependências estão completas
  for (const step of plan.steps) {
    if (step.status === "pending") {
      const depsMet = step.dependencies.every((depId) => {
        const dep = plan.steps.find((s) => s.id === depId);
        return dep?.status === "completed";
      });

      if (depsMet) {
        return step;
      }
    }
  }

  return null;
}

/**
 * Aplica correção a uma etapa (modifica o plano in-place).
 */
export function applyCorrection(
  plan: Plan,
  stepId: string,
  suggestedCorrection: string | null,
  reason: string
): CorrectionRecord {
  const step = plan.steps.find((s) => s.id === stepId);
  if (!step) {
    throw new Error(`Step '${stepId}' not found in plan`);
  }

  const originalStep: PlanStep = { ...step };

  // Incrementa attempts
  step.attempts += 1;

  // Se há sugestão de correção, atualiza a descrição/objetivo
  if (suggestedCorrection) {
    step.description = `${step.description} (Correção: ${suggestedCorrection})`;
    step.objective = suggestedCorrection;
  }

  // Mantém status pending para re-execução
  step.status = "pending";

  const correctionRecord: CorrectionRecord = {
    stepId,
    originalStep,
    correctedStep: { ...step },
    reason,
    timestamp: Date.now(),
  };

  return correctionRecord;
}

/**
 * Replaneja: gera um novo plano substituindo/reorganizando etapas restantes.
 *
 * NÃO apenas adiciona uma etapa no final — substitui o restante do plano.
 */
export async function replan(
  task: string,
  profile: TaskProfile,
  currentPlan: Plan,
  failedStepId: string,
  runner: LLMRunner | undefined,
  providers: Map<string, ProviderAdapter>,
  decisionProvider: string | null,
  decisionModel: string | null,
  retrievedMemory: RetrievedMemory[],
  maxPlanSteps: number
): Promise<{ newPlan: Plan; replanRecord: ReplanRecord }> {
  // Identifica etapas restantes (pending + running + failed - tudo que não foi completado)
  const remainingSteps = currentPlan.steps.filter(
    (s) => s.status !== "completed"
  );

  // Contexto: etapas já completadas
  const completedSteps = currentPlan.steps.filter((s) => s.status === "completed");
  const contextStr = completedSteps
    .map((s) => `${s.description}: ${s.result ?? "(sem resultado)"}`)
    .join("\n");

  // Gera novo plano com contexto de falha
  const plannerResult = await planTask(
    `${task}\n\nCONTEXTO DE FALHA: A etapa '${failedStepId}' falhou. ` +
    `Etapas já completadas:\n${contextStr}\n\nGere um novo plano para concluir a tarefa.`,
    profile,
    runner,
    providers,
    decisionProvider,
    decisionModel,
    retrievedMemory,
    maxPlanSteps
  );

  const newPlan = plannerResult.plan;

  // Preserva etapas já completadas no novo plano
  const mergedSteps: PlanStep[] = [
    ...completedSteps,
    ...newPlan.steps.filter(
      (s) => !completedSteps.some((c) => c.id === s.id)
    ),
  ];

  // Reindexa
  mergedSteps.forEach((s, idx) => {
    s.index = idx;
  });

  const finalPlan: Plan = {
    id: `plan-replan-${Date.now()}`,
    steps: mergedSteps,
    nextStepId: mergedSteps.find((s) => s.status === "pending")?.id ?? null,
  };

  const replanRecord: ReplanRecord = {
    reason: `Replanejamento após falha na etapa '${failedStepId}'`,
    oldPlan: currentPlan,
    newPlan: finalPlan,
    timestamp: Date.now(),
    replacedStepIds: remainingSteps.map((s) => s.id),
  };

  return { newPlan: finalPlan, replanRecord };
}
