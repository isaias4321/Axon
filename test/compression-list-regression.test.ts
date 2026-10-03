import { describe, it, expect } from "vitest";

import { validateStep } from "../src/adaptive/validator.js";
import type { Observation, PlanStep } from "../src/adaptive/types.js";
import { analyzeTask } from "../src/adaptive/taskAnalyzer.js";
import { buildToolInput } from "../src/adaptive/executor.js";

/**
 * Regressão real: depois de corrigir a CompressionTool para listar entradas
 * de um .zip/.rar de verdade (ação "list", devolvendo
 * {tool:"compression", action:"list", entries:[...]}), o validador ainda
 * rejeitava esse resultado — `isStructuredListEvidence` só aceitava
 * `tool === "filesystem"`. Uma listagem genuinamente bem-sucedida (com
 * dezenas de milhares de entradas reais) era descartada como "sem
 * evidência estruturada", e o loop autônomo desistia com no_progress mesmo
 * a tool tendo funcionado perfeitamente.
 */
function makeObservation(overrides: Partial<Observation>): Observation {
  return {
    success: true,
    output: null,
    error: null,
    exitCode: 0,
    durationMs: 10,
    toolName: "compression",
    metadata: { operation: "list" },
    ...overrides,
  };
}

const dummyProfile = analyzeTask("leia este arquivo para mim");

describe("validateStep — evidência de listagem (filesystem vs compression)", () => {
  it("aceita uma listagem bem-sucedida vinda da tool 'compression' (regressão)", async () => {
    const observation = makeObservation({
      output: JSON.stringify({
        tool: "compression",
        action: "list",
        path: "/app/axon.zip",
        format: "zip",
        entries: ["axon/package.json", "axon/src/index.ts"],
      }),
    });

    const result = await validateStep("leia este arquivo", "Listar o conteúdo do arquivo axon.zip", observation, "execucao_ferramenta", {
      enableCritic: false,
      profile: dummyProfile,
      providers: new Map(),
    });

    expect(result.passed).toBe(true);
  });

  it("continua aceitando uma listagem bem-sucedida vinda da tool 'filesystem' (comportamento original preservado)", async () => {
    const observation = makeObservation({
      toolName: "filesystem",
      output: JSON.stringify({
        tool: "filesystem",
        action: "list",
        path: "/app",
        entries: ["package.json", "src"],
      }),
    });

    const result = await validateStep("liste os arquivos", "Listar arquivos do diretório", observation, "execucao_ferramenta", {
      enableCritic: false,
      profile: dummyProfile,
      providers: new Map(),
    });

    expect(result.passed).toBe(true);
  });

  it("rejeita uma listagem sem entradas (array vazio), venha de qual tool for", async () => {
    const observation = makeObservation({
      output: JSON.stringify({ tool: "compression", action: "list", path: "/app/vazio.zip", format: "zip", entries: [] }),
    });

    const result = await validateStep("leia este arquivo", "Listar o conteúdo do arquivo vazio.zip", observation, "execucao_ferramenta", {
      enableCritic: false,
      profile: dummyProfile,
      providers: new Map(),
    });

    expect(result.passed).toBe(false);
  });

  it("rejeita saída de listagem de uma tool desconhecida/não reconhecida", () => {
    const observation = makeObservation({
      toolName: "shell",
      output: JSON.stringify({ tool: "shell", action: "list", entries: ["a", "b"] }),
    });
    // toolName "shell" não é filesystem nem compression — não deve contar
    // como evidência estruturada de listagem.
    return validateStep("liste", "Listar via shell", observation, "execucao_ferramenta", {
      enableCritic: false,
      profile: dummyProfile,
      providers: new Map(),
    }).then((result) => {
      expect(result.passed).toBe(false);
    });
  });
});

/**
 * Regressão real: pedir para CRIAR um .rar levava a uma etapa de criação de
 * arquivo-fonte (ex.: "Criar arquivo de texto exemplo para ser incluído no
 * rar") sendo desviada para a ação "list" da CompressionTool, apontando
 * para um arquivo que ainda nem existia (`example.txt`) — porque a etapa
 * (ou seu objetivo gerado pelo planner) mencionava palavras como
 * "conteúdo"/"incluído" que batiam no detector de leitura de arquivo
 * compactado. Isso sempre falhava com "File not found".
 */
describe("buildToolInput — compression: criação não é desviada para 'list'", () => {
  function makeStep(overrides: Partial<PlanStep>): PlanStep {
    return {
      id: "step-1",
      index: 0,
      description: "",
      capability: "execucao_ferramenta",
      dependencies: [],
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
      ...overrides,
    };
  }

  it("uma etapa de CRIAÇÃO com objetivo mencionando 'conteúdo'/'incluir' não vira ação 'list'", () => {
    const step = makeStep({
      description: "Criar arquivo de texto exemplo para ser incluído no rar",
      objective: "Definir o conteúdo do arquivo de texto a ser incluído no arquivo compactado",
    });

    const result = buildToolInput("compression", step, "crie um arquivo win.rar pra mim sobre qualquer coisa");

    if (result.success) {
      expect(result.action).not.toBe("list");
      if ("value" in result && result.value && "inputPath" in result.value) {
        // Nunca deve tentar listar um arquivo de texto solto (não é um .zip/.rar).
        expect(String(result.value.inputPath)).toMatch(/\.(zip|rar)$/i);
      }
    }
  });

  it("uma etapa de LEITURA genuína (sem verbo de criação) de um .zip existente ainda vira 'list'", () => {
    const step = makeStep({
      description: "Listar o conteúdo do arquivo axon-corrigido3.zip",
    });

    const result = buildToolInput("compression", step, "leia este arquivo axon-corrigido3.zip para mim e me diga oq e");

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.action).toBe("list");
    }
  });
});
