/**
 * Fase 9 — RecoveryCell.
 *
 * Responsável por detectar bloqueios/falhas recorrentes, propor estratégia
 * alternativa e acionar replanning — sempre com limite anti-loop.
 *
 * Núcleo determinístico: conta falhas consecutivas e sugere a próxima ação
 * (retry / replan / escalar ao agente principal / abortar).
 */

import type {
  CellInput,
  CellOutput,
  CellExecutionContext,
  CellCapability,
  CellType,
  CellId,
} from "../types.js";
import { BaseCognitiveCell } from "../cell.js";

export interface RecoveryInput extends CellInput {
  type: "recovery";
  payload: {
    /** Descrição do bloqueio/erro. */
    failure: string;
    /** Número de tentativas consecutivas falhas. */
    consecutiveFailures: number;
    /** Máximo de tentativas antes de escalar. */
    maxAttempts?: number;
    /** Última ação tentada (opcional). */
    lastAction?: string;
    /** Ações já tentadas (para evitar repetição). */
    triedActions?: string[];
  };
}

export interface RecoveryOutput {
  status: "retry" | "replan" | "escalate" | "abort";
  reason: string;
  suggestedStrategy: string;
  /** Recomendações concretas para o replan (ex.: mudar capability/abordagem). */
  recommendations: string[];
  /** true se o loop deve parar (limite atingido). */
  stop: boolean;
  attemptsUsed: number;
  maxAttempts: number;
}

export class RecoveryCell extends BaseCognitiveCell<RecoveryInput, RecoveryOutput> {
  public readonly id: CellId = "recovery-cell-1";
  public readonly type: CellType = "recovery";
  public readonly name = "RecoveryCell";
  public readonly capabilities: CellCapability[] = ["root_cause_analysis"];
  public readonly description = "Detecta bloqueios, propõe estratégia alternativa e evita loops infinitos";

  protected async executeImpl(
    input: RecoveryInput,
    _context: CellExecutionContext
  ): Promise<RecoveryOutput> {
    const {
      failure,
      consecutiveFailures,
      maxAttempts = 3,
      lastAction,
      triedActions = [],
    } = input.payload;

    const attemptsUsed = consecutiveFailures;
    const reachedLimit = attemptsUsed >= maxAttempts;
    const repeatingAction = lastAction !== undefined && triedActions.includes(lastAction);

    let status: RecoveryOutput["status"];
    let suggestedStrategy: string;

    // Lógica anti-loop determinística
    if (reachedLimit) {
      // Limite atingido → escalar ao agente principal (não abortar cegamente)
      status = "escalate";
      suggestedStrategy =
        `Limite de ${maxAttempts} tentativas atingido. Escalar decisão ao agente principal.`;
    } else if (repeatingAction && attemptsUsed > 1) {
      // Está repetindo a MESMA ação sem sucesso após mais de uma tentativa → replan
      status = "replan";
      suggestedStrategy =
        `Repetição da ação "${lastAction}" sem sucesso. Substituir abordagem.`;
    } else if (attemptsUsed === 0 || attemptsUsed === 1) {
      // Primeira falha (ou uma única falha anterior) → retry simples
      status = "retry";
      suggestedStrategy = "Falha inicial. Tentar novamente com a mesma abordagem.";
    } else {
      // Falhas crescentes mas abaixo do limite → replan leve
      status = "replan";
      suggestedStrategy =
        `${attemptsUsed} falha(s) consecutiva(s). Alterar abordagem antes de novas tentativas.`;
    }

    const recommendations = this.buildRecommendations(status, failure, triedActions);

    return {
      status,
      reason: `Falha: ${failure}. Tentativas: ${attemptsUsed}/${maxAttempts}.`,
      suggestedStrategy,
      recommendations,
      stop: status === "escalate",
      attemptsUsed,
      maxAttempts,
    };
  }

  private buildRecommendations(
    status: RecoveryOutput["status"],
    failure: string,
    triedActions: string[]
  ): string[] {
    const recs: string[] = [];

    if (status === "retry") {
      recs.push(`Retentar a mesma abordagem, possivelmente com variação (ex.: outro provedor/modelo).`);
      recs.push("Coletar mais evidências antes de considerar falha permanente.");
    } else if (status === "replan") {
      recs.push(`Trocar a capability/abordagem para "${failure}".`);
      recs.push(`Eliminar da repetição as ações já tentadas: ${triedActions.join(", ") || "nenhuma"}.`);
      recs.push("Redefinir o plano restante a partir do ponto de falha.");
    } else if (status === "escalate") {
      recs.push("Devolver o controle ao agente principal com o relatório de falha.");
      recs.push("Sugerir task nova ou revisar os objetivos, evitando repetir a mesma rota.");
    }

    return recs;
  }
}