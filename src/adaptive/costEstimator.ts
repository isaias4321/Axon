/**
 * Fase 3 — Token & Cost Engine.
 *
 * Projeção de custo USD de um request, 100% offline e determinística.
 * Usa o preço input/output do `MODEL_CATALOG`; quando um modelo não tem o
 * split (ou está fora do catálogo), cai no blend `costPer1MTokens` — a mesma
 * fonte do RANKING do Model Router.
 *
 * Distinção (documentada no `/v1/decide`):
 * - `decision.costEstimate` — blend usado para ranking;
 * - `estimation.costUsd` — projeção com preço refinado (split input/output).
 */

import { MODEL_CATALOG, type ModelEntry } from "./modelCatalog.js";
import {
  estimateMessagesTokens,
  estimateTextTokens,
  type ChatMessageLike,
} from "./tokenEstimator.js";

export interface CostPrice {
  /** USD por 1M tokens de INPUT. */
  inputPer1M: number;
  /** USD por 1M tokens de OUTPUT. */
  outputPer1M: number;
}

export interface CostEstimate {
  model: string;
  inputTokens: number;
  /** Null quando o request não tem saída (ex: `/v1/decide`, que só estima o input). */
  outputTokens: number | null;
  totalTokens: number;
  /** Null quando o modelo está fora do catálogo. */
  costUsd: number | null;
  inputCostPer1MTokens: number | null;
  outputCostPer1MTokens: number | null;
}

export interface ChatCostFields {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  /** Omitido (nunca null) quando o modelo está fora do catálogo. */
  estimatedCostUsd?: number;
}

/**
 * Preço input/output do modelo. Ausência de split → usa `costPer1MTokens`
 * como blend (mesmo valor para input e output). Fora do catálogo → null.
 */
export function costPriceFor(
  model: string,
  catalog: readonly ModelEntry[] = MODEL_CATALOG
): CostPrice | null {
  const entry = catalog.find((item) => item.model === model);
  if (!entry) return null;

  const { inputCostPer1MTokens, outputCostPer1MTokens, costPer1MTokens } = entry;
  return {
    inputPer1M: inputCostPer1MTokens ?? costPer1MTokens,
    outputPer1M: outputCostPer1MTokens ?? costPer1MTokens,
  };
}

/**
 * `(input / 1e6) * inputPer1M + (output / 1e6) * outputPer1M`.
 */
export function estimateCostUsd(
  price: CostPrice,
  inputTokens: number,
  outputTokens: number
): number {
  return (
    (inputTokens / 1_000_000) * price.inputPer1M +
    (outputTokens / 1_000_000) * price.outputPer1M
  );
}

/**
 * Projeção de custo de uma tarefa em texto — só input (o `/v1/decide` não
 * tem saída). `model: null` → `null` (não há modelo vencedor).
 */
export function estimateTaskCost(
  model: string | null,
  text: string,
  catalog: readonly ModelEntry[] = MODEL_CATALOG
): CostEstimate | null {
  if (model === null) return null;

  const price = costPriceFor(model, catalog);
  const inputTokens = estimateTextTokens(text);

  if (price === null) {
    return {
      model,
      inputTokens,
      outputTokens: null,
      totalTokens: inputTokens,
      costUsd: null,
      inputCostPer1MTokens: null,
      outputCostPer1MTokens: null,
    };
  }

  return {
    model,
    inputTokens,
    outputTokens: null,
    totalTokens: inputTokens,
    costUsd: estimateCostUsd(price, inputTokens, 0),
    inputCostPer1MTokens: price.inputPer1M,
    outputCostPer1MTokens: price.outputPer1M,
  };
}

/**
 * Campos de custo para anexar a uma resposta de chat (não-streaming).
 * `estimatedOutputTokens` prefere o `usage.completion_tokens` real do
 * provedor (de graça); sem ele, estima pelo `content` retornado.
 * Modelo fora do catálogo → `estimatedCostUsd` OMITIDO (spread condicional,
 * coerente com `z.number().optional()` que rejeita `null`).
 */
export function estimateChatCost(
  model: string,
  messages: readonly ChatMessageLike[],
  content: string,
  usage: { completion_tokens?: number } | undefined,
  catalog: readonly ModelEntry[] = MODEL_CATALOG
): ChatCostFields {
  const estimatedInputTokens = estimateMessagesTokens(messages);
  const estimatedOutputTokens =
    usage?.completion_tokens ?? estimateTextTokens(content);

  const price = costPriceFor(model, catalog);
  if (price === null) {
    return { estimatedInputTokens, estimatedOutputTokens };
  }

  return {
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedCostUsd: estimateCostUsd(price, estimatedInputTokens, estimatedOutputTokens),
  };
}
