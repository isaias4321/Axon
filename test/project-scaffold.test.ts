import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";

import { analyzeTask, detectToolIntent, isCapabilityQuestion } from "../src/adaptive/taskAnalyzer.js";
import { decideStrategy } from "../src/adaptive/strategyEngine.js";
import { ProjectTool, sanitizeProjectName } from "../src/adaptive/tools/projectTool.js";
import { createProjectZip } from "../src/lib/compression.js";
import { runProjectScaffold } from "../src/adaptive/projectScaffold.js";
import { executeTask, type LLMRunner } from "../src/adaptive/runtime.js";
import { InMemorySessionStore } from "../src/adaptive/memory.js";
import type { ProviderAdapter } from "../src/providers/types.js";
import type { ChatCompletionResponse } from "../src/schemas/chat.js";

let workspaceDir: string;
let previousWorkspace: string | undefined;

beforeAll(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "axon-project-test-"));
  previousWorkspace = process.env.AXON_WORKSPACE;
  process.env.AXON_WORKSPACE = workspaceDir;
});

afterAll(() => {
  if (previousWorkspace === undefined) delete process.env.AXON_WORKSPACE;
  else process.env.AXON_WORKSPACE = previousWorkspace;
  rmSync(workspaceDir, { recursive: true, force: true });
});

afterEach(() => {
  for (const entry of readdirSync(workspaceDir)) {
    rmSync(join(workspaceDir, entry), { recursive: true, force: true });
  }
});

function fakeAdapter(provider: string): ProviderAdapter {
  return { name: provider as ProviderAdapter["name"], complete: vi.fn(), stream: vi.fn() };
}

function buildProviders(...names: string[]): Map<string, ProviderAdapter> {
  const map = new Map<string, ProviderAdapter>();
  for (const name of names) map.set(name, fakeAdapter(name));
  return map;
}

function runnerReturning(content: string): LLMRunner {
  return {
    complete: vi.fn().mockResolvedValue({
      id: "resp-1",
      provider: "groq",
      model: "openai/gpt-oss-20b",
      content,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      cached: false,
    } satisfies ChatCompletionResponse) as LLMRunner["complete"],
  };
}

const VALID_PROJECT_JSON = JSON.stringify({
  projectName: "Meu App Simples",
  files: [
    { path: "README.md", content: "# Meu App\n\nRode com: node src/index.js\n" },
    { path: "package.json", content: '{"name":"meu-app","version":"1.0.0"}' },
    { path: "src/index.js", content: 'console.log("olá, mundo");\n' },
    { path: "src/utils/soma.js", content: "module.exports = (a, b) => a + b;\n" },
  ],
});

const DECISION = { provider: "groq", model: "openai/gpt-oss-20b", rankedCandidates: [] };

/**
 * O agente precisa entender a diferença entre uma PERGUNTA ("você consegue
 * criar um zip?" → responde "sim, consigo") e uma ORDEM ("faça um projeto e
 * me envie em um zip" → executa de verdade).
 */
describe("pergunta vs. ordem", () => {
  it("pergunta de capacidade pura NÃO executa nada (responde em texto)", () => {
    expect(isCapabilityQuestion("Vc consegue criar um arquivo zip pra mim?")).toBe(true);
    expect(detectToolIntent("Vc consegue criar um arquivo zip pra mim?")).toBeNull();
    expect(decideStrategy(analyzeTask("Vc consegue criar um arquivo zip pra mim?")).strategy).toBe("single_agent");
  });

  it("ordem imperativa de criar um projeto e enviar em zip EXECUTA (intent 'project')", () => {
    for (const order of [
      "Faça um projeto e me envie em um zip.",
      "Faca um projeto e me envie em um zip",
      "Crie um projeto básico em Python e me mande compactado",
      "Monte um aplicativo simples de tarefas e me entregue em zip",
    ]) {
      expect(isCapabilityQuestion(order)).toBe(false);
      expect(detectToolIntent(order)).toBe("project");
      expect(decideStrategy(analyzeTask(order)).strategy).toBe("autonomous");
    }
  });

  it("pedido educado disfarçado de pergunta ('consegue X e me manda?') também EXECUTA", () => {
    const text = "consegue criar um projeto basico e me mandar em zip?";
    expect(isCapabilityQuestion(text)).toBe(false);
    expect(detectToolIntent(text)).toBe("project");
  });

  it("'projeto' como substantivo comum NÃO vira scaffold (só quando o verbo cria o projeto)", () => {
    // Regressão real: "Audite o projeto sem escrever arquivos" casava
    // "projeto" + "escrever" e virava scaffold em vez de leitura.
    expect(detectToolIntent("Audite o projeto sem escrever arquivos. Leia src/lib/db/driver.ts.")).toBe("filesystem");
    expect(detectToolIntent("Analise o projeto e me diga o que ele faz")).not.toBe("project");
    expect(detectToolIntent("Gere um relatório do projeto")).not.toBe("project");
    expect(detectToolIntent("Não crie um projeto novo, só leia o README.md")).not.toBe("project");
  });

  it("não confunde pedidos que só mencionam zip com scaffold de projeto", () => {
    expect(detectToolIntent("crie um arquivo zip com o relatorio.txt")).toBe("document");
    expect(detectToolIntent("leia o conteúdo do arquivo dados.zip")).toBe("compression");
  });
});

describe("sanitizeProjectName", () => {
  it("normaliza nomes para algo seguro como pasta/arquivo", () => {
    expect(sanitizeProjectName("Meu App Simples")).toBe("Meu-App-Simples");
    expect(sanitizeProjectName("../../etc")).toBe("etc");
    expect(sanitizeProjectName("   ")).toBe("projeto");
    expect(sanitizeProjectName("a/b\\c")).toBe("a-b-c");
  });
});

describe("createProjectZip", () => {
  it("preserva a estrutura de pastas do projeto no zip", async () => {
    const tool = new ProjectTool({ fsRoot: workspaceDir } as never);
    const res = await tool.execute({
      action: "scaffold",
      projectName: "estrutura",
      zip: false,
      files: [
        { path: "a.txt", content: "A" },
        { path: "pasta/b.txt", content: "B" },
        { path: "pasta/sub/c.txt", content: "C" },
      ],
    });
    expect(res.success).toBe(true);

    const out = join(workspaceDir, "estrutura.zip");
    const zipRes = createProjectZip(join(workspaceDir, "estrutura"), out);
    expect(zipRes.success).toBe(true);

    const names = new AdmZip(out).getEntries().map((e) => e.entryName).filter((n) => !n.endsWith("/"));
    expect(names.sort()).toEqual(["a.txt", "pasta/b.txt", "pasta/sub/c.txt"]);
  });

  it("falha de forma clara quando o diretório não existe", () => {
    const res = createProjectZip(join(workspaceDir, "nao-existe"), join(workspaceDir, "x.zip"));
    expect(res.success).toBe(false);
    expect(res.error).toContain("Directory not found");
  });
});

describe("ProjectTool", () => {
  const tool = () => new ProjectTool({ fsRoot: workspaceDir } as never);

  it("cria todos os arquivos (com subpastas) e entrega um .zip", async () => {
    const res = await tool().execute({
      action: "scaffold",
      projectName: "meu-app",
      files: [
        { path: "README.md", content: "# oi" },
        { path: "src/index.js", content: "console.log(1)" },
      ],
    });

    expect(res.success).toBe(true);
    expect(readFileSync(join(workspaceDir, "meu-app", "src", "index.js"), "utf-8")).toBe("console.log(1)");
    expect(existsSync(join(workspaceDir, "meu-app.zip"))).toBe(true);
    expect(res.metadata.zipPath).toBe(join(workspaceDir, "meu-app.zip"));
  });

  it("recusa caminhos que tentam escapar da pasta do projeto (path traversal)", async () => {
    const res = await tool().execute({
      action: "scaffold",
      projectName: "seguro",
      zip: false,
      files: [
        { path: "../fora.txt", content: "malicioso" },
        { path: "/etc/passwd", content: "malicioso" },
        { path: "ok.txt", content: "bom" },
      ],
    });

    expect(res.success).toBe(true);
    expect(existsSync(join(workspaceDir, "fora.txt"))).toBe(false);
    expect(existsSync(join(workspaceDir, "seguro", "ok.txt"))).toBe(true);
    expect(res.output).toContain("ignorado");
  });

  it("falha quando TODOS os caminhos são inválidos", async () => {
    const res = await tool().execute({
      action: "scaffold",
      projectName: "vazio",
      files: [{ path: "../a.txt", content: "x" }],
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("Nenhum arquivo válido");
  });
});

describe("runProjectScaffold", () => {
  it("gera o projeto a partir de um JSON válido do LLM e devolve o caminho do zip", async () => {
    const report = await runProjectScaffold("Faça um projeto e me envie em um zip", DECISION, buildProviders("groq"), {
      runner: runnerReturning(VALID_PROJECT_JSON),
    });

    expect(report.executed).toBe(true);
    expect(report.error).toBeNull();
    expect(report.zipPath).toBe(join(workspaceDir, "Meu-App-Simples.zip"));
    expect(report.filesCreated).toHaveLength(4);
    // O caminho do zip aparece no texto final → o frontend o transforma em botão de download.
    expect(report.content).toContain("Meu-App-Simples.zip");

    const names = new AdmZip(report.zipPath!).getEntries().map((e) => e.entryName);
    expect(names).toContain("src/utils/soma.js");
  });

  it("tolera JSON embrulhado em cercas de markdown (comum mesmo pedindo JSON puro)", async () => {
    const report = await runProjectScaffold("crie um projeto", DECISION, buildProviders("groq"), {
      runner: runnerReturning("Claro! Aqui está:\n```json\n" + VALID_PROJECT_JSON + "\n```\nBom proveito!"),
    });
    expect(report.executed).toBe(true);
  });

  it("reporta com clareza quando o modelo não devolve JSON", async () => {
    const report = await runProjectScaffold("crie um projeto", DECISION, buildProviders("groq"), {
      runner: runnerReturning("Desculpe, não posso ajudar com isso."),
    });
    expect(report.executed).toBe(false);
    expect(report.error).toBe("invalid_json_response");
    expect(report.content).toContain("JSON válido");
  });

  it("reporta com clareza quando o JSON não segue o schema esperado", async () => {
    const report = await runProjectScaffold("crie um projeto", DECISION, buildProviders("groq"), {
      runner: runnerReturning(JSON.stringify({ projectName: "x", files: [] })),
    });
    expect(report.executed).toBe(false);
    expect(report.error).toBe("schema_validation_failed");
  });

  it("não tenta executar sem modelo disponível", async () => {
    const report = await runProjectScaffold("crie um projeto", { provider: null, model: null }, buildProviders("groq"));
    expect(report.executed).toBe(false);
    expect(report.error).toBe("no_model_available");
  });
});

describe("executeTask — ordem de criar projeto, ponta a ponta", () => {
  it("'Faça um projeto e me envie em um zip' cria os arquivos, gera o zip e salva na memória", async () => {
    const store = new InMemorySessionStore();
    const report = await executeTask("Faça um projeto e me envie em um zip.", buildProviders("groq", "openai"), {
      runner: runnerReturning(VALID_PROJECT_JSON),
      sessionStore: store,
      sessionId: "sessao-projeto",
    });

    expect(report.strategy.strategy).toBe("autonomous");
    expect(report.taskProfile.toolIntent).toBe("project");
    expect(report.execution.executed).toBe(true);
    expect(report.projectScaffold?.zipPath).toBe(join(workspaceDir, "Meu-App-Simples.zip"));
    expect(existsSync(join(workspaceDir, "Meu-App-Simples", "src", "index.js"))).toBe(true);
    expect(report.execution.content).toContain("Meu-App-Simples.zip");

    // O que foi entregue fica na memória — o próximo turno sabe do projeto.
    const memory = store.recall("sessao-projeto");
    expect(memory.some((m) => m.role === "assistant" && m.content.includes("Meu-App-Simples.zip"))).toBe(true);
  });

  it("uma PERGUNTA sobre a capacidade não cria nada", async () => {
    const runner = runnerReturning("Sim, eu consigo criar arquivos zip!");
    const report = await executeTask("Vc consegue criar um arquivo zip pra mim?", buildProviders("groq", "openai"), {
      runner,
    });

    expect(report.strategy.strategy).toBe("single_agent");
    expect(report.projectScaffold).toBeUndefined();
    expect(readdirSync(workspaceDir)).toHaveLength(0);
    expect(report.execution.content).toContain("Sim, eu consigo");
  });
});
