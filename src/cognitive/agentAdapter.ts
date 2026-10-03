/**
 * Fase 9 — Agent Adapter (integração Cognitive Cells ↔ Autonomous Agent).
 *
 * Conecta o oferecimento das células cognitivas ao loop autônomo (F6) de forma
 * opt-in e fail-open:
 *
 * - `runAutonomous` continua 100% igual quando `enableCognitive` é false.
 * - Quando true e uma célula falha/indisponível, o loop segue o comportamento
 *   padrão (nunca quebra por causa das células).
 *
 * O objetivo é permitir que o resultado de uma célula ALTERE a decisão do
 * agente (o gap #1 da auditoria), sem reescrever a arquitetura F1–F8.
 */

import type { CognitiveCell, CognitiveMemory, CellExecutionContext } from "./types.js";
import { ValidationCell, type ValidationOutput } from "./cells/validation.js";
import { RecoveryCell, type RecoveryOutput } from "./cells/recovery.js";

/**
 * Opções cognitivas aceitas pelo loop autônomo (opt-in).
 */
export interface CognitiveAgentOptions {
  /** Liga o uso de células cognitivas no loop (default false — preserva F1–F8). */
  enableCognitive?: boolean;
  /** Memória cognitiva compartilhada (opcional). */
  cognitiveMemory?: CognitiveMemory;
  /** Células extras além de Validation/Recovery (opcional, registro por tipo). */
  extraCells?: CognitiveCell[];
  /** Configuração do contexto das células. */
  cellContext?: Partial<CellExecutionContext>;
}

/**
 * Resultado da validação/recuperação de uma etapa via células.
 */
export interface CognitiveStepResult {
  /** Rah raiz sugerida pela RecoveryCell, quando aplicável. */
  suggestedAction: "continue" | "retry" | "replan" | "escalate";
  /** Veredito da ValidationCell, quando aplicável. */
  validated: boolean;
  /** Recomendações da RecoveryCell (para replanning). */
  recommendations: string[];
  /** Metadados da(s) célula(s) que atuaram. */
  usedCells: string[];
  /** Erro da célula (se houve), com fail-open. */
  error: string | null;
}

/**
 * Valida um resultado de etapa usando a ValidationCell real.
 * Fail-open: se a célula falhar, `validated` reflete o `fallback` informado.
 */
export async function validateWithCell(
  objective: string,
  result: unknown,
  context: Pick<CellExecutionContext, "sessionId" | "taskId">,
  cell?: CognitiveCell | null
): Promise<CognitiveStepResult> {
  const usedCells: string[] = [];
  const validationCell = cell ?? new ValidationCell();

  try {
    const output = await validationCell.execute(
      { type: "validation", payload: { objective, result, mode: result === null ? "presence" : "not_empty" } },
      buildCellCtx(context)
    );
    usedCells.push(validationCell.id);

    const data = output.data as ValidationOutput | undefined;
    return {
      suggestedAction: data?.suggestedAction === "replan" ? "replan" : data?.suggestedAction === "retry" ? "retry" : "continue",
      validated: data ? data.verdict === "pass" : true,
      recommendations: [],
      usedCells,
      error: output.error ? output.error.message : null,
    };
  } catch (error) {
    return {
      suggestedAction: "continue",
      validated: true, // fail-open: sem célula, segue o fluxo padrão
      recommendations: [],
      usedCells,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Decide recuperação usando a RecoveryCell real. Fail-open.
 */
export async function recoverWithCell(
  failure: string,
  consecutiveFailures: number,
  maxAttempts: number,
  context: Pick<CellExecutionContext, "sessionId" | "taskId">,
  cell?: CognitiveCell | null
): Promise<CognitiveStepResult> {
  const usedCells: string[] = [];
  const recoveryCell = cell ?? new RecoveryCell();

  try {
    const output = await recoveryCell.execute(
      {
        type: "recovery",
        payload: { failure, consecutiveFailures, maxAttempts },
      },
      buildCellCtx(context)
    );
    usedCells.push(recoveryCell.id);

    const data = output.data as RecoveryOutput | undefined;
    return {
      suggestedAction: data?.status === "retry" ? "retry"
        : data?.status === "replan" ? "replan"
        : data?.status === "escalate" ? "escalate" : "continue",
      validated: data?.status !== "escalate",
      recommendations: data?.recommendations ?? [],
      usedCells,
      error: output.error ? output.error.message : null,
    };
  } catch (error) {
    return {
      suggestedAction: "continue",
      validated: true,
      recommendations: [],
      usedCells,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildCellCtx(context: Pick<CellExecutionContext, "sessionId" | "taskId">): CellExecutionContext {
  return {
    sessionId: context.sessionId,
    taskId: context.taskId,
    taskProfile: {
      capabilities: ["validacao"],
      category: "geral",
      complexity: "media",
      text: "",
      hints: [],
      wordCount: 0,
      charCount: 0,
    },
    cognitiveMemory: undefined as never, // define pelo caller se necessário
    budgets: { maxTokens: 50000, maxDurationMs: 60000, maxToolCalls: 20, maxCostUsd: 0.10 },
    availableTools: [],
    sandboxConfig: { fsRoot: "~/.axon", allowedTools: [], allowShell: false, allowHttp: false, allowedEnvVars: [] },
  };
}