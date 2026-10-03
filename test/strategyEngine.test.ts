import { describe, expect, it } from "vitest";
import { decideStrategy } from "../src/adaptive/strategyEngine.js";
import type { TaskProfile } from "../src/adaptive/taskAnalyzer.js";

function profile(overrides: Partial<TaskProfile>): TaskProfile {
  return {
    text: "tarefa de teste",
    complexity: "media",
    category: "geral",
    capabilities: ["raciocinio"],
    wordCount: 4,
    charCount: 16,
    hints: [],
    ...overrides,
  };
}

describe("decideStrategy", () => {
  it("retorna single_agent para tarefa de complexidade baixa", () => {
    const decision = decideStrategy(
      profile({ complexity: "baixa", capabilities: ["conversa"] })
    );

    expect(decision.strategy).toBe("single_agent");
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  it("retorna single_agent para tarefa de complexidade media", () => {
    const decision = decideStrategy(
      profile({ complexity: "media", capabilities: ["raciocinio"] })
    );

    expect(decision.strategy).toBe("single_agent");
  });

  it("retorna multi_agent para tarefa alta com múltiplas capacidades", () => {
    const decision = decideStrategy(
      profile({
        complexity: "alta",
        capabilities: ["planejamento", "geracao_codigo"],
      })
    );

    expect(decision.strategy).toBe("multi_agent");
  });

  it("retorna autonomous para tarefas com gatilhos explícitos de autonomia", () => {
    const decision = decideStrategy(
      profile({
        text: "Execute a otimização de código em um loop autônomo com adaptação",
        complexity: "alta",
        capabilities: ["geracao_codigo", "validacao"],
      })
    );

    expect(decision.strategy).toBe("autonomous");
  });

  it("retorna no_execution para tarefa ambígua (menos de 2 palavras)", () => {
    const decision = decideStrategy(profile({ wordCount: 1, text: "?" }));

    expect(decision.strategy).toBe("no_execution");
    expect(decision.reason).toContain("ambígua");
  });
});
