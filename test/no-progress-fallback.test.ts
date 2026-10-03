import { describe, it, expect } from "vitest";
import { validateStep } from "../src/adaptive/validator.ts";
import { runAutonomous } from "../src/adaptive/autonomous.ts";
import { DEFAULT_SECURITY_POLICY } from "../src/adaptive/tools/security.ts";

describe("Tratamento do erro no_progress e Validação de Tools", () => {
  it("valida saídas de ferramentas registradas como document, compression e image deterministicamente", async () => {
    const observation = {
      success: true,
      output: "Created ZIP at /tmp/file.zip",
      error: null,
      exitCode: 0,
      durationMs: 10,
      filesChanged: ["/tmp/file.zip"],
      toolName: "compression",
      metadata: { operation: "zip" },
    };

    const res = await validateStep(
      "Compactar arquivos",
      "Executar compactacao",
      observation,
      "execucao_ferramenta",
      {
        enableCritic: true,
        profile: { category: "geral", complexity: "alta", capabilities: ["execucao_ferramenta"] },
        providers: new Map(),
      }
    );

    expect(res.passed).toBe(true);
    expect(res.validatorType).toBe("heuristic");
  });

  it("retorna um erro estruturado e amigável caso a tool de filesystem falhe em vez de estouro não-capturado", async () => {
    const observation = {
      success: false,
      output: null,
      error: "File not found: /caminho/invalido.txt",
      exitCode: 1,
      durationMs: 15,
      filesChanged: [],
      toolName: "filesystem",
      metadata: { operation: "read" },
    };

    const res = await validateStep(
      "Ler arquivo inexistente",
      "Ler /caminho/invalido.txt",
      observation,
      "execucao_ferramenta",
      {
        enableCritic: false,
        profile: { category: "geral", complexity: "baixa", capabilities: ["execucao_ferramenta"] },
        providers: new Map(),
      }
    );

    expect(res.passed).toBe(false);
    expect(res.issues.some((i) => i.includes("File not found"))).toBe(true);
  });

  it("deriva corretamente ferramenta compression para arquivos .rar a partir da tarefa", async () => {
    const { buildToolInput } = await import("../src/adaptive/executor.js");
    const step = {
      id: "step-1",
      index: 0,
      description: "Executar a ação real necessária via ferramenta",
      capability: "execucao_ferramenta" as const,
      dependencies: [],
      status: "pending" as const,
      attempts: 0,
      maxAttempts: 3,
    };
    const task = "Compacte os arquivos doc1.txt e doc2.txt em teste.rar";

    const toolInput = buildToolInput("compression", step, task);
    expect(toolInput.success).toBe(true);
    if (toolInput.success) {
      expect(toolInput.action).toBe("rar");
      expect(toolInput.value).toEqual({
        action: "rar",
        outputPath: "teste.rar",
        sourcePaths: ["doc1.txt", "doc2.txt"],
      });
    }
  });
});
