/**
 * Fase 9 — ValidationCell.
 *
 * Responsável por verificar resultados de etapas/planos; detectar falhas; e
 * impedir que uma solução incorreta seja considerada sucesso.
 *
 * Reaproveita heurísticas determinísticas (sem LLM) e pode, em extensão
 * futura, chamar um critic LLM. Núcleo mínimo para fechar o ciclo cognitivo.
 */

import type {
  CellInput,
  CellExecutionContext,
  CellCapability,
  CellType,
  CellId,
} from "../types.js";
import { BaseCognitiveCell } from "../cell.js";

export type ValidationVerdict = "pass" | "fail" | "warn";

export interface ValidationInput extends CellInput {
  type: "validation";
  payload: {
    /** Descrição/objetivo da etapa sendo validada. */
    objective: string;
    /** Resultado produzido pela etapa/célula. */
    result?: unknown;
    /** Tipo de validação (heurística, presença, estrutura, não-vazio, etc.). */
    mode?: "presence" | "structure" | "not_empty" | "truthy" | "any";
    /** Evidências extras para a checagem. */
    checks?: Array<{ label: string; pass: boolean; detail?: string }>;
  };
}

export interface ValidationFinding {
  check: string;
  verdict: ValidationVerdict;
  detail?: string;
}

export interface ValidationOutput {
  verdict: ValidationVerdict;
  findings: ValidationFinding[];
  /** true se a etapa pode seguir. */
  canContinue: boolean;
  /** Ação sugerida em caso de falha. */
  suggestedAction: "continue" | "retry" | "replan" | "abort";
  summary: string;
}

export class ValidationCell extends BaseCognitiveCell<ValidationInput, ValidationOutput> {
  public readonly id: CellId = "validation-cell-1";
  public readonly type: CellType = "validation";
  public readonly name = "ValidationCell";
  public readonly capabilities: CellCapability[] = [
    "code_review_correctness",
    "code_review_security",
  ];
  public readonly description = "Valida resultados de etapas, detecta falhas e impede sucesso falso";

  protected async executeImpl(
    input: ValidationInput,
    _context: CellExecutionContext
  ): Promise<ValidationOutput> {
    const {
      objective,
      result,
      mode = "any",
      checks = [],
    } = input.payload;

    const findings: ValidationFinding[] = [];

    // 1. Checagens explícitas fornecidas
    for (const c of checks) {
      findings.push({
        check: c.label,
        verdict: c.pass ? "pass" : "fail",
        detail: c.detail,
      });
    }

    // 2. Checagem baseada no modo escolhido
    const resultExists = result !== undefined && result !== null;
    let modeVerdict: ValidationVerdict;
    let modeDetail: string | undefined;

    switch (mode) {
      case "presence":
        modeVerdict = resultExists ? "pass" : "fail";
        modeDetail = resultExists ? "Resultado presente" : "Resultado ausente";
        break;
      case "not_empty": {
        const nonEmpty = resultExists &&
          (Array.isArray(result)
            ? result.length > 0
            : typeof result === "string" || typeof result === "number"
              ? String(result).trim().length > 0
              : typeof result === "object"
                ? Object.keys(result).length > 0
                : false);
        modeVerdict = nonEmpty ? "pass" : "fail";
        modeDetail = modeVerdict === "pass" ? "Resultado não vazio" : "Resultado vazio ou ausente";
        break;
      }
      case "structure":
        modeVerdict = resultExists && typeof result === "object" ? "pass" : "fail";
        modeDetail = modeVerdict === "pass" ? "Estrutura válida" : "Estrutura inválida";
        break;
      case "truthy":
        modeVerdict = resultExists && Boolean(result) ? "pass" : "fail";
        modeDetail = modeVerdict === "pass" ? "Valor truthy" : "Valor falsy/ausente";
        break;
      case "any":
      default:
        modeVerdict = "pass";
        modeDetail = "Modo 'any' — sem checagem de conteúdo";
        break;
    }

    if (mode !== "any") {
      findings.push({
        check: objective,
        verdict: modeVerdict,
        detail: modeDetail,
      });
    }

    // 3. Determinar veredito geral
    const hasFail = findings.some(f => f.verdict === "fail");
    const hasWarn = findings.some(f => f.verdict === "warn");

    const verdict: ValidationVerdict = hasFail ? "fail" : hasWarn ? "warn" : "pass";
    const canContinue = verdict !== "fail";

    // Ação sugerida
    let suggestedAction: ValidationOutput["suggestedAction"] = "continue";
    if (verdict === "fail") suggestedAction = "retry";
    if (verdict === "warn") suggestedAction = "replan";

    const summary = `Validação de "${objective}": ${verdict}` +
      (findings.length ? ` (${findings.filter(f => f.verdict === "fail").length} falhas)` : "");

    return {
      verdict,
      findings,
      canContinue,
      suggestedAction,
      summary,
    };
  }
}