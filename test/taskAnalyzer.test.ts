import { describe, expect, it } from "vitest";
import {
  analyzeTask,
  classifyComplexity,
  classifyCategory,
} from "../src/adaptive/taskAnalyzer.js";

describe("analyzeTask", () => {
  it("classifica um cumprimento como conversação/baixa com capability 'conversa'", () => {
    const profile = analyzeTask("Olá, tudo bem?");

    expect(profile.category).toBe("conversacao");
    expect(profile.complexity).toBe("baixa");
    expect(profile.capabilities).toContain("conversa");
    expect(profile.hints.length).toBeGreaterThan(0);
  });

  it("classifica uma pergunta simples como conversação/baixa", () => {
    const profile = analyzeTask("Qual a capital do Brasil?");

    expect(profile.category).toBe("conversacao");
    expect(profile.complexity).toBe("baixa");
  });

  it("classifica um pedido de arquitetura como planejamento/alta com capacidades múltiplas", () => {
    const profile = analyzeTask(
      "Construa uma arquitetura de microsserviços em Python FastAPI com Postgres, testes unitários, Docker e CI/CD. Liste os módulos e os endpoints."
    );

    expect(profile.category).toBe("planejamento");
    expect(profile.complexity).toBe("alta");
    expect(profile.capabilities).toContain("planejamento");
    expect(profile.capabilities).toContain("geracao_codigo");
    expect(profile.capabilities).toContain("validacao");
    // Regra de afinamento: planejamento alto também exige análise.
    expect(profile.capabilities).toContain("analise");
  });

  it("classifica um pedido de correção de código como código", () => {
    const profile = analyzeTask(
      "Refatore este código e corrija o bug no endpoint /users"
    );

    expect(profile.category).toBe("codigo");
    expect(profile.capabilities).toContain("geracao_codigo");
    expect(profile.capabilities).toContain("validacao");
  });

  it("classifica uma análise de desempenho como análise", () => {
    const profile = analyzeTask(
      "Analise os problemas de desempenho desta aplicação"
    );

    expect(profile.category).toBe("analise");
    expect(profile.capabilities).toContain("analise");
  });

  it("normaliza o texto (trim) e preenche métricas", () => {
    const profile = analyzeTask("  Oi  ");

    expect(profile.text).toBe("Oi");
    expect(profile.wordCount).toBe(1);
    expect(profile.charCount).toBe(2);
  });
});

describe("classifyComplexity", () => {
  it("retorna baixa para texto muito curto", () => {
    const { complexity } = classifyComplexity("oi", 1, 2);
    expect(complexity).toBe("baixa");
  });

  it("retorna media para texto grande (>= 90 palavras) sem outros fatores", () => {
    // Pelo plano: contexto grande = +2, mapeado para "media" (1–2).
    const text = Array.from({ length: 95 }, (_, i) => `palavra${i}`).join(" ");
    const { complexity } = classifyComplexity(text, 95, text.length);
    expect(complexity).toBe("media");
  });

  it("retorna media para texto médio sem verbos complexos", () => {
    const text = Array.from({ length: 30 }, () => "item").join(" ");
    const { complexity } = classifyComplexity(text, 30, text.length);
    expect(complexity).toBe("media");
  });

  it("retorna alta para texto com 2+ verbos complexos", () => {
    const { complexity } = classifyComplexity(
      "projete e analise esta solução",
      5,
      32
    );
    expect(complexity).toBe("alta");
  });

  it("inclui hints de rastreabilidade", () => {
    const { hints } = classifyComplexity("construa e valide", 3, 19);
    expect(hints.length).toBeGreaterThan(0);
  });
});

describe("classifyCategory", () => {
  it("prioriza planejamento sobre código quando ambos aparecem", () => {
    const { category } = classifyCategory(
      "Construa uma arquitetura de microsserviços em Python FastAPI"
    );
    expect(category).toBe("planejamento");
  });

  it("detecta código", () => {
    const { category } = classifyCategory("corrija o bug no endpoint /users");
    expect(category).toBe("codigo");
  });

  it("detecta análise", () => {
    const { category } = classifyCategory(
      "compare o desempenho das duas soluções"
    );
    expect(category).toBe("analise");
  });

  it("detecta conversa por cumprimento", () => {
    const { category } = classifyCategory("Oi, tudo bem?");
    expect(category).toBe("conversacao");
  });

  it("detecta conversa por pergunta curta", () => {
    const { category } = classifyCategory("Qual a capital do Brasil?");
    expect(category).toBe("conversacao");
  });

  it("cai em geral para texto sem intenção clara", () => {
    const { category } = classifyCategory(
      "existe algum tipo de informação relevante sobre esse assunto"
    );
    expect(category).toBe("geral");
  });
});
