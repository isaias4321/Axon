import { describe, expect, it, vi } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { runAutonomous } from "../src/adaptive/autonomous.js";
import { decideStrategy } from "../src/adaptive/strategyEngine.js";
import { routeModel } from "../src/adaptive/modelRouter.js";
import {
  analyzeTask,
  detectFilesystemIntent,
  hasAffirmativeReadRequest,
  hasAffirmativeWriteRequest,
  resolveFilesystemIntent,
} from "../src/adaptive/taskAnalyzer.js";
import {
  buildToolInput,
  deriveFileRead,
  deriveFileWrite,
  executeOneStep,
} from "../src/adaptive/executor.js";
import { createDefaultToolRegistry, getWorkspaceRoot } from "../src/adaptive/tools/registry.js";
import { setDriverForTest, createInMemoryDriver } from "../src/lib/db/driver.js";
import { runMigrations } from "../src/lib/db/migrations.js";
import type { ProviderAdapter } from "../src/providers/types.js";
import type { LLMRunner } from "../src/adaptive/runtime.js";
import type { PlanStep } from "../src/adaptive/types.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../src/schemas/chat.js";

/**
 * Regressao da causa raiz: `buildToolInput()` tentava `deriveFileWrite()` ANTES
 * de qualquer outra derivacao, entao tarefas READ-ONLY com verbos de escrita
 * (mesmo negados - "nao crie", "sem escrever") ou com qualquer texto curto
 * depois de um caminho viravam `filesystem.write`, sobrescrevendo arquivos do
 * projeto com fragmentos do proprio enunciado.
 *
 * A decisao agora e: `capability da etapa` -> `intencao (read/write/list)` ->
 * derivacao especifica. Escrita so existe com intencao afirmativa E etapa de
 * `execucao_ferramenta`; qualquer ambiguidade resolve para read-only.
 */

const WORKSPACE = getWorkspaceRoot();
const SERVER_FILE = "src/server.ts";

function fakeAdapter(provider: string): ProviderAdapter {
  return { name: provider as ProviderAdapter["name"], complete: vi.fn(), stream: vi.fn() };
}

function buildProviders(...names: string[]): Map<string, ProviderAdapter> {
  return new Map(names.map((name) => [name, fakeAdapter(name)]));
}

function freshRegistry() {
  return createDefaultToolRegistry({
    enableHistory: true,
    security: { fsRoot: getWorkspaceRoot() },
  });
}

function operations(registry: ReturnType<typeof freshRegistry>): string[] {
  return registry.getHistory().map((entry) => {
    const operation = entry.result.metadata?.operation;
    return typeof operation === "string" ? operation : "unknown";
  });
}

function makeStep(
  capability: PlanStep["capability"],
  description: string,
  objective = description
): PlanStep {
  return {
    id: "step-1",
    index: 0,
    description,
    objective,
    capability,
    dependencies: [],
    status: "pending",
    attempts: 0,
    maxAttempts: 3,
  };
}

function llmResponse(content: string, request: ChatCompletionRequest): ChatCompletionResponse {
  return {
    id: "resp",
    provider: request.provider,
    model: request.model,
    content,
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    cached: false,
  };
}
describe("detectFilesystemIntent — intenção explícita (não presença de palavra)", () => {
  it("classifica pedidos legítimos de write/read/list", () => {
    expect(detectFilesystemIntent('Crie hello.txt contendo exatamente "Hello from Axon".')).toBe("write");
    expect(detectFilesystemIntent("Escreva em hello.txt o seguinte conteúdo: ABC123")).toBe("write");
    expect(detectFilesystemIntent("Leia src/server.ts e explique a função principal.")).toBe("read");
    expect(detectFilesystemIntent("Liste recursivamente a estrutura do workspace")).toBe("list");
  });

  it("trata negação: verbo de escrita negado NUNCA vira write", () => {
    expect(detectFilesystemIntent("Leia src/server.ts e não altere nenhum arquivo.")).toBe("read");
    expect(
      detectFilesystemIntent("Não crie nem modifique arquivos. Liste a estrutura do workspace.")
    ).toBe("list");
    expect(
      detectFilesystemIntent("Audite o projeto sem escrever arquivos. Leia src/lib/db/driver.ts.")
    ).toBe("read");
    expect(detectFilesystemIntent("Não escrever em src/server.ts; apenas leia o arquivo.")).toBe("read");
    expect(
      detectFilesystemIntent(
        "Não criar, não escrever, não salvar, não gravar nem alterar arquivos. Apenas leia e audite o projeto."
      )
    ).toBe("read");
  });

  it("não classifica cláusula reportada como pedido de escrita", () => {
    // "verifique se o projeto cria ..." descreve um comportamento a investigar:
    // pode ser read-only, mas NUNCA write.
    expect(detectFilesystemIntent("Verifique se o projeto cria arquivos temporários.")).not.toBe("write");
  });

  it("retorna null quando não há pedido de filesystem", () => {
    expect(detectFilesystemIntent("Qual a capital do Brasil?")).toBeNull();
    expect(detectFilesystemIntent("")).toBeNull();
  });

  it("resolveFilesystemIntent prioriza a tarefa (pedido original) sobre o rótulo da etapa", () => {
    const task = "Leia src/server.ts e não altere nenhum arquivo.";
    expect(resolveFilesystemIntent(task, "Criar o arquivo src/server.ts")).toBe("read");
    expect(resolveFilesystemIntent('Crie hello.txt contendo exatamente "oi"', "")).toBe("write");
  });

  it("hasAffirmativeWriteRequest distingue pedido de negação e respeita contraste", () => {
    expect(hasAffirmativeWriteRequest('Crie hello.txt contendo exatamente "oi"')).toBe(true);
    expect(hasAffirmativeWriteRequest("Não crie nem modifique arquivos.")).toBe(false);
    expect(hasAffirmativeWriteRequest("Apenas audite o projeto sem escrever arquivos.")).toBe(false);
    expect(hasAffirmativeWriteRequest('Não altere a.txt, mas crie b.txt contendo "x"')).toBe(true);
  });

  it("hasAffirmativeReadRequest distingue leitura de negação", () => {
    expect(hasAffirmativeReadRequest("Leia src/server.ts e explique")).toBe(true);
    expect(hasAffirmativeReadRequest("Não leia src/server.ts")).toBe(false);
  });

  it("analyzeTask expõe filesystemIntent para a etapa", () => {
    expect(analyzeTask('Crie hello.txt contendo exatamente "oi"').filesystemIntent).toBe("write");
    expect(analyzeTask("Leia src/server.ts e não altere nenhum arquivo.").filesystemIntent).toBe("read");
    expect(analyzeTask("Analise a estrutura do workspace").filesystemIntent).toBe("list");
  });
});

describe("deriveFileWrite / deriveFileRead — derivação sem invenção", () => {
  it("deriveFileWrite exige conteúdo EXPLÍCITO (marcador ou aspas)", () => {
    expect(deriveFileWrite("Criar ./tmp/axon-test.txt com o conteúdo AXON_OK")).toEqual({
      path: "./tmp/axon-test.txt",
      content: "AXON_OK",
    });
    expect(deriveFileWrite('Crie hello.txt contendo exatamente "Hello from Axon".')).toEqual({
      path: "hello.txt",
      content: "Hello from Axon",
    });
    expect(deriveFileWrite("Escreva em hello.txt o seguinte conteúdo: ABC123")).toEqual({
      path: "hello.txt",
      content: "ABC123",
    });
  });

  it("deriveFileWrite NÃO converte o resto da instrução em conteúdo (fallback perigoso removido)", () => {
    expect(deriveFileWrite("Crie um arquivo relatorio.md sobre o projeto")).toBeNull();
    expect(deriveFileWrite("Nao escrever em src/routes/models.ts; apenas leia o arquivo.")).toBeNull();
  });

  it("deriveFileWrite recusa pedidos negados mesmo com caminho presente", () => {
    expect(deriveFileWrite("Não escrever em src/server.ts; apenas leia o arquivo.")).toBeNull();
    expect(deriveFileWrite("Audite o projeto sem escrever arquivos em src/server.ts")).toBeNull();
  });

  it("deriveFileRead preserva leitura legítima e recusa leitura negada", () => {
    expect(deriveFileRead("Leia src/server.ts e não altere nenhum arquivo.")).toEqual({
      path: "src/server.ts",
    });
    expect(deriveFileRead("Ler o arquivo src/routes/models.ts para confirmar as alterações")).toEqual({
      path: "src/routes/models.ts",
    });
    expect(deriveFileRead("Não leia src/server.ts")).toBeNull();
  });
});
describe("buildToolInput — capability → intenção → derivação específica", () => {
  const readTask1 = "Leia src/server.ts e não altere nenhum arquivo.";
  const listTask2 = "Não crie nem modifique arquivos. Liste a estrutura do workspace.";
  const readTask3 = "Audite o projeto sem escrever arquivos. Leia src/lib/db/driver.ts.";
  const writeTask4 = 'Crie hello.txt contendo exatamente "Hello from Axon".';
  const writeTask5 = "Escreva em hello.txt o seguinte conteúdo: ABC123";
  const reportTask6 = "Verifique se o projeto cria arquivos temporários.";
  const readTask7 = "Não escrever em src/server.ts; apenas leia o arquivo.";
  const readTask9 =
    "Não criar, não escrever, não salvar, não gravar nem alterar arquivos. Apenas leia e audite o projeto.";

  it("TESTE 4/5 — write + execucao_ferramenta → filesystem.write com conteúdo exato", () => {
    expect(buildToolInput("filesystem", makeStep("execucao_ferramenta", writeTask4), writeTask4)).toEqual({
      success: true,
      action: "write",
      value: { path: "hello.txt", content: "Hello from Axon" },
    });
    expect(buildToolInput("filesystem", makeStep("execucao_ferramenta", writeTask5), writeTask5)).toEqual({
      success: true,
      action: "write",
      value: { path: "hello.txt", content: "ABC123" },
    });
  });

  it("TESTE 1/3/7 — intenção read → read (NUNCA write)", () => {
    for (const task of [readTask1, readTask3, readTask7]) {
      const out = buildToolInput("filesystem", makeStep("execucao_ferramenta", task), task);
      expect(out.success).toBe(true);
      if (out.success) expect(out.action).toBe("read");
    }
  });

  it("TESTE 9 — negação múltipla sem caminho nunca vira write", () => {
    const out = buildToolInput("filesystem", makeStep("execucao_ferramenta", readTask9), readTask9);
    expect(out.success === false || out.action !== "write").toBe(true);
  });

  it("TESTE 2 — intenção list → list", () => {
    const out = buildToolInput("filesystem", makeStep("execucao_ferramenta", listTask2), listTask2);
    expect(out.success).toBe(true);
    if (out.success) expect(out.action).toBe("list");
  });

  it("TESTE 6 — cláusula reportada não vira write", () => {
    const out = buildToolInput("filesystem", makeStep("execucao_ferramenta", reportTask6), reportTask6);
    expect(out.success === false || out.action !== "write").toBe(true);
  });

  it("etapa read-only (analise) nunca deriva write, mesmo com tarefa de escrita", () => {
    const writeTask = 'Crie src/server.ts contendo exatamente "x"';
    const out = buildToolInput("filesystem", makeStep("analise", "Analisar src/server.ts"), writeTask);
    expect(out.success === false || out.action !== "write").toBe(true);
  });

  it("intenção write sem conteúdo explícito não inventa escrita", () => {
    const task = "Crie um arquivo relatorio.md sobre o projeto";
    const out = buildToolInput("filesystem", makeStep("execucao_ferramenta", task), task);
    expect(out.success === false || out.action !== "write").toBe(true);
  });

  it("writeAllowed não eleva etapa read-only nem intenção não-write", () => {
    const writeTask = 'Crie src/server.ts contendo exatamente "x"';
    const wrongStep = buildToolInput("filesystem", makeStep("analise", "Analisar src/server.ts"), writeTask, {
      writeAllowed: true,
    });
    expect(wrongStep.success === false || wrongStep.action !== "write").toBe(true);

    const readTask = "Leia src/server.ts e não altere nenhum arquivo.";
    const wrongIntent = buildToolInput("filesystem", makeStep("execucao_ferramenta", readTask), readTask, {
      writeAllowed: true,
    });
    expect(wrongIntent.success === false || wrongIntent.action !== "write").toBe(true);
  });
});
describe("executeOneStep + ToolRegistry REAL — etapas read-only nunca escrevem", () => {
  it("TESTE 1 — 'Leia src/server.ts e não altere nenhum arquivo.' → read, filesChanged []", async () => {
    const registry = freshRegistry();
    const task = "Leia src/server.ts e não altere nenhum arquivo.";
    const result = await executeOneStep(makeStep("execucao_ferramenta", task), task, analyzeTask(task), {
      toolRegistry: registry,
      providers: buildProviders("gemini"),
      useTool: "filesystem",
    });

    expect(result.observation.metadata.operation).toBe("read");
    expect(result.observation.filesChanged ?? []).toEqual([]);
    expect(result.observation.output).toBe(readFileSync(join(WORKSPACE, SERVER_FILE), "utf-8"));
    expect(operations(registry)).not.toContain("write");
  });

  it("TESTE 2 — 'Não crie... Liste...' → list, filesChanged []", async () => {
    const registry = freshRegistry();
    const task = "Não crie nem modifique arquivos. Liste a estrutura do workspace.";
    const result = await executeOneStep(makeStep("execucao_ferramenta", task), task, analyzeTask(task), {
      toolRegistry: registry,
      providers: buildProviders("gemini"),
      useTool: "filesystem",
    });

    expect(result.observation.metadata.operation).toBe("list");
    expect(result.observation.filesChanged ?? []).toEqual([]);
    expect(operations(registry)).not.toContain("write");
  });

  it("TESTE 3 — 'Audite ... sem escrever ... Leia driver.ts' → read, NUNCA write", async () => {
    const registry = freshRegistry();
    const task = "Audite o projeto sem escrever arquivos. Leia src/lib/db/driver.ts.";
    const result = await executeOneStep(makeStep("execucao_ferramenta", task), task, analyzeTask(task), {
      toolRegistry: registry,
      providers: buildProviders("gemini"),
      useTool: "filesystem",
    });

    expect(result.observation.metadata.operation).toBe("read");
    expect(String(result.observation.output ?? "")).toContain("DatabaseSync");
    expect(result.observation.filesChanged ?? []).toEqual([]);
    expect(operations(registry)).not.toContain("write");
  });

  it("TESTE 7 — 'Não escrever em src/server.ts; apenas leia' → read, NUNCA write", async () => {
    const registry = freshRegistry();
    const task = "Não escrever em src/server.ts; apenas leia o arquivo.";
    const result = await executeOneStep(makeStep("execucao_ferramenta", task), task, analyzeTask(task), {
      toolRegistry: registry,
      providers: buildProviders("gemini"),
      useTool: "filesystem",
    });

    expect(result.observation.metadata.operation).toBe("read");
    expect(result.observation.filesChanged ?? []).toEqual([]);
    expect(operations(registry)).not.toContain("write");
  });

  it("TESTE 6/9 — negação múltipla não produz nenhum write", async () => {
    const registry = freshRegistry();
    const tasks = [
      "Verifique se o projeto cria arquivos temporários.",
      "Não criar, não escrever, não salvar, não gravar nem alterar arquivos. Apenas leia e audite o projeto.",
    ];
    for (const task of tasks) {
      await executeOneStep(makeStep("execucao_ferramenta", task), task, analyzeTask(task), {
        toolRegistry: registry,
        providers: buildProviders("gemini"),
        useTool: "filesystem",
      });
    }

    expect(operations(registry)).not.toContain("write");
  });
});
describe("write real e READ -> ANALYZE", () => {
  it("TESTE 4/5 — write real com conteúdo explícito e read-back", async () => {
    const registry = freshRegistry();
    const rel4 = "tmp/axon-intent-write.txt";
    const abs4 = join(WORKSPACE, rel4);
    const task4 = `Crie ${rel4} contendo exatamente "Hello from Axon".`;

    const write4 = await executeOneStep(makeStep("execucao_ferramenta", task4), task4, analyzeTask(task4), {
      toolRegistry: registry,
      providers: buildProviders("gemini"),
      useTool: "filesystem",
    });

    expect(write4.observation.success).toBe(true);
    expect(write4.observation.metadata.operation).toBe("write");
    expect(readFileSync(abs4, "utf-8")).toBe("Hello from Axon");

    const rel5 = "tmp/axon-intent-abc.txt";
    const abs5 = join(WORKSPACE, rel5);
    const task5 = `Escreva em ${rel5} o seguinte conteúdo: ABC123`;
    const write5 = await executeOneStep(makeStep("execucao_ferramenta", task5), task5, analyzeTask(task5), {
      toolRegistry: registry,
      providers: buildProviders("gemini"),
      useTool: "filesystem",
    });

    expect(write5.observation.success).toBe(true);
    expect(readFileSync(abs5, "utf-8")).toBe("ABC123");

    rmSync(abs4, { force: true });
    rmSync(abs5, { force: true });
  });

  it("TESTE 8 — READ -> ANALYZE preserva o conteúdo real no contexto do LLM", async () => {
    const registry = freshRegistry();
    const task = "Leia src/server.ts e explique a função principal.";
    const readResult = await executeOneStep(
      makeStep("execucao_ferramenta", "Ler src/server.ts"),
      task,
      analyzeTask(task),
      { toolRegistry: registry, providers: buildProviders("gemini"), useTool: "filesystem" }
    );

    const realContent = readFileSync(join(WORKSPACE, SERVER_FILE), "utf-8");
    expect(readResult.observation.output).toBe(realContent);
    expect(readResult.observation.filesChanged ?? []).toEqual([]);

    const runner = {
      complete: vi.fn().mockResolvedValue({
        id: "resp-analyze",
        provider: "gemini",
        model: "gemini-2.5-flash",
        content: "O arquivo inicializa o servidor e registra as rotas.",
        cached: false,
      } satisfies ChatCompletionResponse),
    };
    await executeOneStep(
      makeStep("analise", "Analisar o conteúdo lido de src/server.ts"),
      task,
      analyzeTask(task),
      {
        runner,
        providers: buildProviders("gemini"),
        accumulatedContext: [`[Evidência filesystem]: ${readResult.observation.output}`],
      }
    );

    const request = runner.complete.mock.calls[0]?.[0] as ChatCompletionRequest;
    const joined = request.messages.map((message) => message.content).join("\n");
    expect(joined).toContain('import "dotenv/config"');
    expect(operations(registry)).not.toContain("write");
  });
});

describe("isolamento entre tasks", () => {
  it("task READ-ONLY depois de uma task WRITE não herda path/conteúdo/intenção", async () => {
    const registry = freshRegistry();
    const writeTask = 'Crie tmp/axon-isolation.txt contendo exatamente "ISOLATED"';
    const writeResult = await executeOneStep(
      makeStep("execucao_ferramenta", writeTask),
      writeTask,
      analyzeTask(writeTask),
      { toolRegistry: registry, providers: buildProviders("gemini"), useTool: "filesystem" }
    );
    expect(writeResult.observation.metadata.operation).toBe("write");

    const before = registry.getHistory().length;
    const readTask = "Leia src/lib/db/driver.ts e não altere nenhum arquivo.";
    expect(analyzeTask(readTask).filesystemIntent).toBe("read");

    const readResult = await executeOneStep(
      makeStep("execucao_ferramenta", readTask),
      readTask,
      analyzeTask(readTask),
      { toolRegistry: registry, providers: buildProviders("gemini"), useTool: "filesystem" }
    );

    const taskBOps = registry
      .getHistory()
      .slice(before)
      .map((entry) => entry.result.metadata?.operation);
    expect(taskBOps).toEqual(["read"]);

    expect(readResult.observation.metadata.operation).toBe("read");
    expect(readResult.observation.filesChanged ?? []).toEqual([]);
    expect(String(readResult.observation.output ?? "")).not.toContain("Written");
    expect(String(readResult.observation.output ?? "")).not.toContain("ISOLATED");

    rmSync(join(WORKSPACE, "tmp", "axon-isolation.txt"), { force: true });
  });
});
describe("loop autônomo — read-only de ponta a ponta", () => {
  it("task read-only executa filesystem.read real e nunca filesystem.write", async () => {
    setDriverForTest(createInMemoryDriver());
    runMigrations();

    const registry = freshRegistry();
    const task = "Leia src/server.ts e não altere nenhum arquivo.";
    const runner: LLMRunner = {
      complete: vi.fn().mockImplementation(async (request: ChatCompletionRequest) => {
        const system = request.messages.find((message) => message.role === "system")?.content ?? "";
        if (system.includes("PLANNER")) {
          return llmResponse(
            JSON.stringify({
              steps: [
                {
                  id: "read",
                  index: 0,
                  description: "Ler src/server.ts e não alterar nenhum arquivo",
                  objective: "Executar filesystem.read real",
                  capability: "execucao_ferramenta",
                  dependencies: [],
                  status: "pending",
                },
              ],
            }),
            request
          );
        }
        return llmResponse("Resumo da estrutura do arquivo.", request);
      }),
    };

    const providers = buildProviders("gemini");
    const profile = analyzeTask(task);
    const strategy = decideStrategy(profile);
    const decision = routeModel(profile, strategy.strategy, providers);

    const report = await runAutonomous(task, profile, strategy, decision, providers, {
      runner,
      toolRegistry: registry,
      persistMemory: false,
      budgets: { maxIterations: 5, maxCostUsd: 1, maxDurationMs: 30000 },
    });

    const ops = registry.getHistory().map((entry) => entry.result.metadata?.operation);
    expect(ops).toContain("read");
    expect(ops).not.toContain("write");
    expect(report.stopReason).toBe("success");
    expect(report.plan.some((step) => step.capability === "execucao_ferramenta")).toBe(true);
    // O conteúdo REAL lido chegou ao resultado final do loop (propagação intacta).
    expect(report.finalResult).toBe(readFileSync(join(WORKSPACE, SERVER_FILE), "utf-8"));
  });

  it("REGRESSÃO — 'liste e leia, depois pare imediatamente' não cria etapa extra e preserva as DUAS evidências", async () => {
    // Reproduz exatamente o teste de regressão real que expôs dois bugs:
    // 1) o planner LLM acrescentava uma 3ª etapa ("validar/formatar
    //    relatório") mesmo com a tarefa dizendo explicitamente "pare
    //    imediatamente" depois das duas operações pedidas — essa etapa
    //    extra disparava uma chamada de LLM (e fallback) desnecessária;
    // 2) o resultado final só carregava o output da ÚLTIMA tool chamada
    //    (o `read`), perdendo silenciosamente a evidência do `list`.
    setDriverForTest(createInMemoryDriver());
    runMigrations();

    const registry = freshRegistry();
    const task =
      "Execute filesystem.list no diretório src e filesystem.read no arquivo package.json. Depois pare imediatamente. Não faça análise.";
    expect(analyzeTask(task).stopsImmediatelyAfterTools).toBe(true);

    let llmCalls = 0;
    const runner: LLMRunner = {
      complete: vi.fn().mockImplementation(async (request: ChatCompletionRequest) => {
        llmCalls += 1;
        const system = request.messages.find((message) => message.role === "system")?.content ?? "";
        if (system.includes("PLANNER")) {
          // Simula EXATAMENTE o comportamento problemático do LLM real: o
          // planner devolve uma 3ª etapa de "formatar relatório" mesmo a
          // tarefa pedindo parada imediata — é isso que a rede de segurança
          // (`stripStepsAfterLastToolWhenImmediateStop`) precisa cortar.
          return llmResponse(
            JSON.stringify({
              steps: [
                {
                  id: "list",
                  index: 0,
                  description: "Listar o conteúdo do diretório src usando filesystem.list",
                  objective: "Executar filesystem.list real",
                  capability: "execucao_ferramenta",
                  dependencies: [],
                  status: "pending",
                },
                {
                  id: "read",
                  index: 1,
                  description: "Ler o arquivo package.json usando filesystem.read",
                  objective: "Executar filesystem.read real",
                  capability: "execucao_ferramenta",
                  dependencies: ["list"],
                  status: "pending",
                },
                {
                  id: "report",
                  index: 2,
                  description: "Validar e formatar o relatório final com os resultados das duas operações",
                  objective: "Consolidar a resposta final",
                  capability: "raciocinio",
                  dependencies: ["list", "read"],
                  status: "pending",
                },
              ],
            }),
            request
          );
        }
        // Se este ponto for alcançado, uma chamada de LLM aconteceu ALÉM do
        // planner — exatamente o bug do fallback desnecessário (Groq →
        // Gemini → Groq → Gemini) visto no log real.
        return llmResponse("NÃO DEVERIA TER SIDO CHAMADO — etapa extra não cortada.", request);
      }),
    };

    const providers = buildProviders("gemini");
    const profile = analyzeTask(task);
    const strategy = decideStrategy(profile);
    const decision = routeModel(profile, strategy.strategy, providers);

    const report = await runAutonomous(task, profile, strategy, decision, providers, {
      runner,
      toolRegistry: registry,
      persistMemory: false,
      budgets: { maxIterations: 5, maxCostUsd: 1, maxDurationMs: 30000 },
    });

    // A etapa "report" foi cortada do plano — sobram só as 2 etapas reais.
    expect(report.plan.map((s) => s.capability)).toEqual(["execucao_ferramenta", "execucao_ferramenta"]);

    // Só UMA chamada de LLM no total: a do planner. Nenhuma chamada extra
    // para "formatar relatório" (e, portanto, nenhum fallback associado).
    expect(llmCalls).toBe(1);

    const ops = registry.getHistory().map((entry) => entry.result.metadata?.operation);
    expect(ops).toEqual(["list", "read"]);
    expect(ops).not.toContain("write");

    expect(report.stopReason).toBe("success");

    // As DUAS evidências reais (list E read) estão presentes no resultado
    // final — nenhuma foi "esquecida" por só refletir a última tool chamada.
    const realFileContent = readFileSync(join(WORKSPACE, "package.json"), "utf-8");
    expect(report.finalResult).toContain(realFileContent.trim());
    expect(report.finalResult).toMatch(/"tool":"filesystem","action":"list"/);
  });
});

describe("Integridade de evidência: list + read + read não se contaminam entre si", () => {
  // Regressão de uma investigação que suspeitou de "ToolResult vazando entre
  // steps" ao ver evidência de write associada a uma etapa de list. A
  // auditoria do código não achou nenhum estado mutável compartilhado entre
  // etapas — estes testes provam isso executando as 3 operações reais
  // (list("."), read(package.json), read(server.ts)) em sequência e
  // verificando que cada evidência final contém EXATAMENTE o resultado da
  // sua própria operação, nunca o de outra.

  it("list(.) → read(package.json) → read(server.ts): cada evidência final é da SUA PRÓPRIA operação", async () => {
    const registry = freshRegistry();
    const task = "Liste a raiz do workspace, leia package.json e leia src/server.ts. Depois pare imediatamente.";
    const profile = analyzeTask(task);
    const providers = buildProviders("gemini");
    const runner: LLMRunner = { complete: vi.fn() };

    const listStep = makeStep("execucao_ferramenta", "Listar recursivamente a estrutura do workspace usando filesystem.list");
    const readPkgStep = makeStep("execucao_ferramenta", "Ler o arquivo package.json usando filesystem.read");
    const readServerStep = makeStep("execucao_ferramenta", "Ler o arquivo src/server.ts usando filesystem.read");

    const listResult = await executeOneStep(listStep, task, profile, { runner, toolRegistry: registry, providers });
    const readPkgResult = await executeOneStep(readPkgStep, task, profile, { runner, toolRegistry: registry, providers });
    const readServerResult = await executeOneStep(readServerStep, task, profile, { runner, toolRegistry: registry, providers });

    // Nenhuma escrita ocorreu, em nenhum momento.
    const ops = operations(registry);
    expect(ops).toEqual(["list", "read", "read"]);
    expect(ops).not.toContain("write");

    // Cada Observation contém EXATAMENTE a evidência da SUA PRÓPRIA operação —
    // nunca "Written X bytes", nunca o conteúdo de outro arquivo.
    expect(listResult.observation.metadata?.operation).toBe("list");
    expect(listResult.observation.output).toMatch(/"tool":"filesystem","action":"list"/);
    expect(listResult.observation.output).not.toMatch(/Written \d+ bytes/);

    const realPkgContent = readFileSync(join(WORKSPACE, "package.json"), "utf-8");
    expect(readPkgResult.observation.metadata?.operation).toBe("read");
    expect(readPkgResult.observation.output).toBe(realPkgContent);
    expect(readPkgResult.observation.output).not.toMatch(/Written \d+ bytes/);

    const realServerContent = readFileSync(join(WORKSPACE, SERVER_FILE), "utf-8");
    expect(readServerResult.observation.metadata?.operation).toBe("read");
    expect(readServerResult.observation.output).toBe(realServerContent);
    expect(readServerResult.observation.output).not.toBe(readPkgResult.observation.output);

    // Confirma que o registro real de chamadas também mantém os 3 resultados
    // intactos e na ordem certa — nenhum foi sobrescrito pelo seguinte.
    const history = registry.getHistory();
    expect(history[0]!.result.output).toBe(listResult.observation.output);
    expect(history[1]!.result.output).toBe(realPkgContent);
    expect(history[2]!.result.output).toBe(realServerContent);
  });

  it("uma etapa de tool NUNCA pode produzir metadata.operation='write' quando a tarefa é read-only", async () => {
    // Defesa em profundidade direta: mesmo que o planner erre a descrição,
    // uma tarefa sem verbo de escrita afirmativo não pode, por construção,
    // fazer nenhuma etapa de execucao_ferramenta resultar em operation="write".
    setDriverForTest(createInMemoryDriver());
    runMigrations();
    const registry = freshRegistry();

    const task = "Leia package.json e não altere nenhum arquivo.";
    const profile = analyzeTask(task);
    expect(profile.filesystemIntent).not.toBe("write");

    const step = makeStep("execucao_ferramenta", "Ler o arquivo package.json");
    const result = await executeOneStep(step, task, profile, {
      runner: { complete: vi.fn() },
      toolRegistry: registry,
      providers: buildProviders("gemini"),
    });

    expect(result.observation.metadata?.operation).toBe("read");
    expect(result.observation.metadata?.operation).not.toBe("write");
    expect(typeof result.observation.output === "string" ? result.observation.output : "").not.toMatch(/Written \d+ bytes/);
    expect(registry.getHistory().map((h) => h.result.metadata?.operation)).not.toContain("write");
  });

  it("uma etapa que só MENCIONA 'filesystem.write' num contexto de verificação não escreve nada", () => {
    // Regressão direta do caso descrito na investigação: uma etapa de
    // diagnóstico que fala sobre write (sem pedir escrita de verdade) não
    // pode ser confundida com um pedido de escrita real.
    const result = deriveFileWrite(
      "Verifique se filesystem.write foi executado e se writeAllowed permaneceu falso durante a investigação"
    );
    expect(result).toBeNull();
  });

  it("um planner que inventa um caminho inexistente falha a validação — nunca finge sucesso", async () => {
    // Regressão exata do sintoma relatado: o planner, numa tarefa
    // exploratória, monta o plano inteiro ANTES de qualquer filesystem.list
    // real acontecer, e pode "chutar" um nome de arquivo plausível (baseado
    // no vocabulário da própria tarefa) que não existe de verdade. Isso não
    // é perda/contaminação de evidência: é uma etapa de leitura mirando um
    // alvo que nunca existiu, e o sistema precisa reportar isso como FALHA
    // real — nunca "✓ Validado" com conteúdo inventado.
    setDriverForTest(createInMemoryDriver());
    runMigrations();
    const registry = freshRegistry();

    const step = makeStep(
      "execucao_ferramenta",
      "Ler o arquivo que implementa o módulo filesystem (src/filesystem.ts)"
    );
    const profile = analyzeTask("Investigue o código-fonte real do projeto. Não invente arquivos.");

    const result = await executeOneStep(step, profile.text, profile, {
      runner: { complete: vi.fn() },
      toolRegistry: registry,
      providers: buildProviders("gemini"),
    });

    expect(result.observation.success).toBe(false);
    expect(result.observation.error).toMatch(/File not found/);

    const { validateStep } = await import("../src/adaptive/validator.js");
    const validation = await validateStep(profile.text, step.description, result.observation, step.capability, {
      enableCritic: false,
      profile,
      runner: { complete: vi.fn() },
      providers: buildProviders("gemini"),
    });
    expect(validation.passed).toBe(false);
  });
});