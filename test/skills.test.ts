import { describe, expect, it } from "vitest";
import { createSkillsState, updateSkill, getSkills, leastConfidentSkill } from "../src/evolution/skills.js";

describe("F7 — Skills", () => {
  it("atualiza skill após sucesso", () => {
    const state = createSkillsState();
    updateSkill(state, "geracao_codigo", true, "Implementar função");

    const skills = getSkills(state);
    expect(skills.length).toBe(1);
    expect(skills[0]!.name).toBe("geracao_codigo");
    expect(skills[0]!.successRate).toBe(1);
    expect(skills[0]!.usageCount).toBe(1);
    expect(skills[0]!.confidence).toBeGreaterThan(0);
  });

  it("atualiza skill após falha", () => {
    const state = createSkillsState();
    updateSkill(state, "geracao_codigo", false, "Função com erro");

    const skills = getSkills(state);
    expect(skills.length).toBe(1);
    expect(skills[0]!.successRate).toBe(0);
    expect(skills[0]!.usageCount).toBe(1);
  });

  it("acumula uso e ajusta successRate", () => {
    const state = createSkillsState();
    updateSkill(state, "analise", true, "Análise A");
    updateSkill(state, "analise", true, "Análise B");
    updateSkill(state, "analise", false, "Análise C");

    const skills = getSkills(state);
    const skill = skills.find((s) => s.name === "analise")!;
    expect(skill.usageCount).toBe(3);
    expect(skill.successRate).toBeCloseTo(2 / 3, 5);
  });

  it("retorna skill de menor confiança", () => {
    const state = createSkillsState();
    updateSkill(state, "geracao_codigo", true, "F1");
    updateSkill(state, "geracao_codigo", true, "F2");
    updateSkill(state, "geracao_codigo", false, "F3");

    const least = leastConfidentSkill(state, "geracao_codigo");
    expect(least).toBeDefined();
    expect(least!.name).toBe("geracao_codigo");
    expect(least!.confidence).toBeLessThan(1);
  });

  it("retorna null para skill inexistente", () => {
    const state = createSkillsState();
    const least = leastConfidentSkill(state, "inexistente");
    expect(least).toBeNull();
  });
});