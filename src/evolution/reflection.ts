/**
 * Fase 7 — Self Reflection Loop.
 *
 * Após uma execução, analisa se o plano funcionou, qual etapa falhou,
 * como melhorar, e se existe conhecimento faltante.
 * Salva aprendizado na memória episódica existente.
 */

import type { EpisodeData } from "../adaptive/episodicMemory.js";
import type { CycleLog } from "../adaptive/progressTracker.js";
import type { ReflectionInput } from "./types.js";
import { memoriesRepo, reflectionsRepo } from "../lib/db/index.js";

/**
 * Analisa um episódio concluído e produz uma reflexão.
 *
 * Extrai:
 * - plan_worked: true se todos os passos validaram com sucesso
 * - failed_step: primeira etapa que falhou (se houver)
 * - improvement_suggestion: derivada de correções/replans
 * - missing_knowledge: inferido de validações com baixa confiança
 * - lessons: array de strings acionáveis
 */
export function reflect(
  _episodeData: EpisodeData | undefined,
  cycleLogs: CycleLog[]
): ReflectionInput {
  // plan_worked: todos os passos validaram?
  const planWorked = cycleLogs.every((log) => log.validation.passed);

  // failed_step: primeira etapa que falhou
  let failedStep: string | null = null;
  for (const log of cycleLogs) {
    if (!log.validation.passed) {
      failedStep = log.stepDescription;
      break;
    }
  }

  // improvement_suggestion: baseada em corrections/replans
  let improvementSuggestion: string | null = null;
  if (cycleLogs.some((log) => log.decision.action === "replan")) {
    improvementSuggestion = "Evitar replanejamento: planejar com mais detalhe inicial";
  } else if (cycleLogs.some((log) => log.decision.action === "correct")) {
    improvementSuggestion = "Incorporar feedback de correções anteriores ao planejar";
  }

  // missing_knowledge: inferido de validações com baixa confiança
  let missingKnowledge: string | null = null;
  const lowConfidenceLogs = cycleLogs.filter(
    (log) => !log.validation.passed && log.validation.confidence < 0.5
  );
  if (lowConfidenceLogs.length > 0) {
    const capabilities = lowConfidenceLogs.map((log) => log.capability);
    missingKnowledge = `Baixa confiança em: ${Array.from(new Set(capabilities)).join(", ")}`;
  }

  // lessons: derivada de generateLessonsLearned + insights de reflexão
  const lessons: string[] = [];

  // Lições dos passos bem-sucedidos
  const successfulLogs = cycleLogs.filter((log) => log.validation.passed);
  if (successfulLogs.length > 0) {
    lessons.push(`${successfulLogs.length} etapa(s) concluída(s) com sucesso`);
    for (const log of successfulLogs.slice(0, 3)) {
      lessons.push(`Etapa '${log.stepDescription}' funcionou na primeira tentativa`);
    }
  }

  // Lições dos passos falhos
  const failedLogs = cycleLogs.filter((log) => !log.validation.passed);
  for (const log of failedLogs.slice(0, 3)) {
    if (log.validation.issues.length > 0) {
      lessons.push(`Etapa '${log.stepDescription}': ${log.validation.issues.join("; ")}`);
    }
  }

  // Recomendações baseadas em replans/corrections
  if (cycleLogs.some((log) => log.decision.action === "replan")) {
    lessons.push("Replanejamento necessário — considere plano mais robusto inicialmente");
  }
  if (cycleLogs.some((log) => log.decision.action === "correct")) {
    lessons.push("Correções aplicadas — incorporar ao planejamento futuro");
  }

  return {
    session_id: "", // será preenchido pelo chamador
    episode_id: null, // será preenchido pelo chamador
    task: "", // será preenchido pelo chamador
    plan_worked: planWorked ? 1 : 0,
    failed_step: failedStep,
    improvement_suggestion: improvementSuggestion,
    missing_knowledge: missingKnowledge,
    lessons,
  };
}

/**
 * Persiste a reflexão na memória episódica (memoriesRepo) como item "episodic"
 * para que buscas futuras possam encontrá-la.
 */
export function saveReflection(data: ReflectionInput): void {
  try {
    memoriesRepo.create({
      type: "episodic",
      episode_id: data.episode_id,
      content_json: JSON.stringify({
        task: data.task,
        plan_worked: data.plan_worked === 1,
        failed_step: data.failed_step,
        improvement_suggestion: data.improvement_suggestion,
        missing_knowledge: data.missing_knowledge,
        lessons: data.lessons,
      }),
      embedding_text: data.task,
      tags_json: JSON.stringify(["reflection", data.missing_knowledge ?? "geral"]),
      relevance_score: 0.8,
    });

    // Persiste também na tabela dedicada `reflections` para o loader F7 ler.
    reflectionsRepo.create({
      session_id: data.session_id,
      episode_id: data.episode_id,
      task: data.task,
      plan_worked: data.plan_worked,
      failed_step: data.failed_step,
      improvement_suggestion: data.improvement_suggestion,
      missing_knowledge: data.missing_knowledge,
      lessons: data.lessons,
    });
  } catch {
    // Falha aberta: não interrompe execução
  }
}