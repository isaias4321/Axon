import { describe, expect, it } from "vitest";

import {
  CHARS_PER_TOKEN,
  TOKENS_PER_MESSAGE_OVERHEAD,
  TOKENS_PER_REQUEST_OVERHEAD,
  estimateMessagesTokens,
  estimateTextTokens,
  type ChatMessageLike,
} from "../src/adaptive/tokenEstimator.js";

describe("estimateTextTokens", () => {
  it("texto vazio → 1 (floor, nunca 0)", () => {
    expect(estimateTextTokens("")).toBe(1);
  });

  it("texto curto (< 4 chars) → 1", () => {
    expect(estimateTextTokens("oi")).toBe(1);
  });

  it("exatamente CHARS_PER_TOKEN chars → 1", () => {
    expect(estimateTextTokens("abcd")).toBe(1);
  });

  it("1 char além do múltiplo → arredonda para cima", () => {
    expect(estimateTextTokens("abcde")).toBe(2);
  });

  it("é determinístico e escala com o tamanho", () => {
    const text = "a".repeat(CHARS_PER_TOKEN * 10);
    expect(estimateTextTokens(text)).toBe(10);
    expect(estimateTextTokens(text)).toBe(estimateTextTokens(text));
  });
});

describe("estimateMessagesTokens", () => {
  it("1 mensagem → overhead de request + overhead de msg + tokens do texto", () => {
    // "Olá!" tem 4 chars → ceil(4/4) = 1
    const tokens = estimateMessagesTokens([{ role: "user", content: "Olá!" }]);
    expect(tokens).toBe(
      TOKENS_PER_REQUEST_OVERHEAD +
        TOKENS_PER_MESSAGE_OVERHEAD +
        estimateTextTokens("Olá!")
    );
    expect(tokens).toBe(2 + 4 + 1);
  });

  it("múltiplas mensagens acumulam o overhead por mensagem", () => {
    const tokens = estimateMessagesTokens([
      { role: "system", content: "Você é um assistente." },
      { role: "user", content: "Olá!" },
    ]);
    const expected =
      TOKENS_PER_REQUEST_OVERHEAD +
      estimateTextTokens("Você é um assistente.") +
      TOKENS_PER_MESSAGE_OVERHEAD +
      estimateTextTokens("Olá!") +
      TOKENS_PER_MESSAGE_OVERHEAD;
    expect(tokens).toBe(expected);
  });

  it("sem mensagens → apenas o overhead de request", () => {
    expect(estimateMessagesTokens([])).toBe(TOKENS_PER_REQUEST_OVERHEAD);
  });

  it("aceita mensagens com shape estrutural (ChatMessageLike)", () => {
    const messages: ChatMessageLike[] = [
      { role: "user", content: "Oi" },
      { role: "assistant", content: "Olá!" },
    ];
    expect(estimateMessagesTokens(messages)).toBeGreaterThan(0);
  });
});
