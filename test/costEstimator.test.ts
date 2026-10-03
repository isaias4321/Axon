import { describe, expect, it } from "vitest";

import {
  costPriceFor,
  estimateChatCost,
  estimateCostUsd,
  estimateTaskCost,
} from "../src/adaptive/costEstimator.js";
import type { ModelEntry } from "../src/adaptive/modelCatalog.js";

describe("costPriceFor", () => {
  it("modelo do catálogo → split input/output conhecido", () => {
    expect(costPriceFor("gpt-4o-mini")).toEqual({
      inputPer1M: 0.15,
      outputPer1M: 0.6,
    });
  });

  it("modelo fora do catálogo → null", () => {
    expect(costPriceFor("nonexistent-model")).toBeNull();
  });

  it("modelo sem split → fallback no blend costPer1MTokens", () => {
    const catalog: readonly ModelEntry[] = [
      {
        provider: "openai",
        model: "blend-only",
        complexitySuitability: ["baixa"],
        costPer1MTokens: 2,
        latencyTier: "baixo",
        capabilities: ["conversa"],
      },
    ];
    expect(costPriceFor("blend-only", catalog)).toEqual({
      inputPer1M: 2,
      outputPer1M: 2,
    });
  });
});

describe("estimateCostUsd", () => {
  it("input 1M + output 0.5M com preço 1/2 → 2.0", () => {
    const price = { inputPer1M: 1, outputPer1M: 2 };
    expect(estimateCostUsd(price, 1_000_000, 500_000)).toBeCloseTo(2.0, 10);
  });
});

describe("estimateTaskCost", () => {
  it("modelo conhecido → projeta custo pelo input e marca saída como null", () => {
    const text = "a".repeat(400); // 400 chars → 100 tokens
    const estimate = estimateTaskCost("gpt-4o-mini", text);
    expect(estimate).not.toBeNull();
    expect(estimate?.model).toBe("gpt-4o-mini");
    expect(estimate?.inputTokens).toBe(100);
    expect(estimate?.outputTokens).toBeNull();
    expect(estimate?.totalTokens).toBe(100);
    expect(estimate?.costUsd).toBeCloseTo((100 / 1e6) * 0.15, 12);
    expect(estimate?.inputCostPer1MTokens).toBe(0.15);
    expect(estimate?.outputCostPer1MTokens).toBe(0.6);
  });

  it("modelo fora do catálogo → custo null, tokens estimados", () => {
    const estimate = estimateTaskCost("nonexistent", "oi");
    expect(estimate).toEqual({
      model: "nonexistent",
      inputTokens: 1,
      outputTokens: null,
      totalTokens: 1,
      costUsd: null,
      inputCostPer1MTokens: null,
      outputCostPer1MTokens: null,
    });
  });

  it("modelo null (sem vencedor) → null", () => {
    expect(estimateTaskCost(null, "qualquer texto")).toBeNull();
  });
});

describe("estimateChatCost", () => {
  const messages = [{ role: "user", content: "Olá!" }];

  it("sem usage → output estimado pelo content retornado", () => {
    const fields = estimateChatCost("gpt-4o-mini", messages, "abcde");
    // input: overhead request(2) + overhead msg(4) + ceil(4/4)=1 → 7
    // output: ceil(5/4)=2
    expect(fields.estimatedInputTokens).toBe(7);
    expect(fields.estimatedOutputTokens).toBe(2);
    expect(fields.estimatedCostUsd).toBeDefined();
    expect(fields.estimatedCostUsd).toBeCloseTo(
      (7 / 1e6) * 0.15 + (2 / 1e6) * 0.6,
      12
    );
  });

  it("com usage.completion_tokens → prefere o valor real", () => {
    const fields = estimateChatCost(
      "gpt-4o-mini",
      messages,
      "conteúdo longo para ignorar",
      { completion_tokens: 7 }
    );
    expect(fields.estimatedOutputTokens).toBe(7);
  });

  it("modelo fora do catálogo → omite estimatedCostUsd (nunca null)", () => {
    const fields = estimateChatCost("nonexistent", messages, "abcde");
    expect(fields.estimatedInputTokens).toBe(7);
    expect(fields.estimatedOutputTokens).toBe(2);
    expect("estimatedCostUsd" in fields).toBe(false);
  });
});
