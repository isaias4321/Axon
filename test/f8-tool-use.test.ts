import { describe, expect, it, vi } from "vitest";
import { runAutonomous } from "../src/adaptive/autonomous.js";
import { analyzeTask } from "../src/adaptive/taskAnalyzer.js";
import { decideStrategy } from "../src/adaptive/strategyEngine.js";
import { routeModel } from "../src/adaptive/modelRouter.js";
import { executeOneStep } from "../src/adaptive/executor.js";
import { validateStep } from "../src/adaptive/validator.js";
import { setDriverForTest, createInMemoryDriver } from "../src/lib/db/driver.js";
import { runMigrations } from "../src/lib/db/migrations.js";
import type { ProviderAdapter } from "../src/providers/types.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../src/schemas/chat.js";
import type { LLMRunner } from "../src/adaptive/runtime.js";
import type { PlanStep } from "../src/adaptive/types.js";
import { ProviderHttpError } from "../src/lib/retry.js";

/**
 * FASE 8 — Prova que o agente executa uma TOOL REAL no loop autônomo.
 *
 * Critério: numa tarefa que exige criar arquivo, decideToolForStep → filesystem
 * e o registry registra a chamada (getHistory não-vazio).
 */

function fakeAdapter(provider: string): ProviderAdapter {
  return {
    name: provider as ProviderAdapter["name"],
    complete: async (req: ChatCompletionRequest): Promise<ChatCompletionResponse> => concreteRunner(req),
    stream: async () => new ReadableStream<Uint8Array>(),
  };
}

function buildProviders(...names: string[]): Map<string, ProviderAdapter> {
  return new Map(names.map((name) => [name, fakeAdapter(name)]));
}

function response(content: string, request: ChatCompletionRequest): ChatCompletionResponse {
  return {
    id: "f8", provider: request.provider, model: request.model, content,
    usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 }, cached: false,
  };
}

function concreteRunner(request: ChatCompletionRequest): ChatCompletionResponse {
  const system = request.messages.find((m) => m.role === "system")?.content ?? "";
  if (system.includes("CRITIC") || system.toUpperCase().includes("CRITIC")) {
    return response(JSON.stringify({ passed: true, confidence: 0.95, issues: [], suggestedCorrection: null }), request);
  }
  if (system.includes("PLANNER") || system.toUpperCase().includes("PLANNER")) {
    return response(JSON.stringify({
      steps: [
        { id: "s1", index: 0, description: "Analisar a tarefa", objective: "Entender", capability: "analise", dependencies: [], status: "pending" },
        { id: "s2", index: 1, description: "Criar arquivo resposta.txt com o resultado", objective: "Escrever arquivo", capability: "execucao_ferramenta", dependencies: ["s1"], status: "pending" },
        { id: "s3", index: 2, description: "Validar o resultado", objective: "Checar", capability: "validacao", dependencies: ["s2"], status: "pending" },
      ],
    }), request);
  }
  return response("Implementação:\n```ts\nexport function resolver() { return 'ok'; }\n```", request);
}

const runner: LLMRunner = {
  complete: async (request: ChatCompletionRequest) => concreteRunner(request),
};

describe("F8 — Tools reais no loop autônomo", () => {
  it("agente executa tool filesystem quando a etapa exige criar arquivo", async () => {
    setDriverForTest(createInMemoryDriver());
    runMigrations();

    const providers = buildProviders("gemini");
    // Registry padrão com filesystem/shell/http — com a MESMA política do loop
    // real: fsRoot = raiz de workspace (AXON_WORKSPACE/cwd), para que caminhos
    // relativos derivados da tarefa resolvam dentro do workspace.
    const { createDefaultToolRegistry, getWorkspaceRoot } = await import("../src/adaptive/tools/registry.js");
    const defaultRegistry = createDefaultToolRegistry({
      enableHistory: true,
      security: { fsRoot: getWorkspaceRoot() },
    });

    const task = "Em modo autônomo, crie um arquivo chamado resposta.txt com o texto 'ok'";
    const profile = analyzeTask(task);
    const strategy = decideStrategy(profile);
    const decision = routeModel(profile, strategy.strategy, providers);

    const report = await runAutonomous(task, profile, strategy, decision, providers, {
      runner,
      sessionId: "f8-tool",
      persistMemory: false,
      toolRegistry: defaultRegistry,
      budgets: { maxIterations: 6, maxCostUsd: 1, maxDurationMs: 30000 },
    });

    expect(report.stopReason).toBe("success");
    console.log("StepLogs:", JSON.stringify(report.stepLogs.map((s) => s.actionDescription), null, 2));

    // Deve existir a etapa de criar arquivo no plano
    const planHasFile = report.plan.some((p) => p.description.toLowerCase().includes("arquivo"));
    expect(planHasFile).toBe(true);

    // PROVA DEFINITIVA: o registry registrou ao menos 1 tool call real
    const history = defaultRegistry.getHistory();
    console.log("Tool calls registradas:", history.map((h) => h.toolName));
    expect(history.length).toBeGreaterThan(0);
    expect(history.some((h) => h.toolName === "filesystem")).toBe(true);
  });

  it("executa filesystem.read real sem fallback para LLM em etapa de execucao_ferramenta", async () => {
    const providers = buildProviders("gemini");
    const { createDefaultToolRegistry, getWorkspaceRoot } = await import("../src/adaptive/tools/registry.js");
    const registry = createDefaultToolRegistry({
      enableHistory: true,
      security: { fsRoot: getWorkspaceRoot() },
    });
    const llmRunner = {
      complete: vi.fn().mockRejectedValue(new Error("fallback llm não deveria ser usado")),
    } satisfies LLMRunner;

    const task = "Ler o arquivo src/routes/models.ts para confirmar as alterações";
    const step: PlanStep = {
      id: "step-read",
      index: 0,
      description: "Ler o arquivo src/routes/models.ts para confirmar as alterações",
      objective: "ler arquivo",
      capability: "execucao_ferramenta",
      dependencies: [],
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
    };

    const result = await executeOneStep(step, task, analyzeTask(task), {
      runner: llmRunner,
      toolRegistry: registry,
      providers,
      useTool: "filesystem",
    });

    expect(result.observation.toolName).toBe("filesystem");
    expect(result.observation.success).toBe(true);
    expect(result.observation.metadata.operation).toBe("read");
    expect(llmRunner.complete).not.toHaveBeenCalled();
  });

  it("não transforma uma solicitação de leitura em filesystem.write", async () => {
    const providers = buildProviders("gemini");
    const { createDefaultToolRegistry, getWorkspaceRoot } = await import("../src/adaptive/tools/registry.js");
    const registry = createDefaultToolRegistry({
      enableHistory: true,
      security: { fsRoot: getWorkspaceRoot() },
    });
    const task = "Leia src/lib/db/driver.ts, explique resumidamente como a camada de persistência está estruturada e não altere nenhum arquivo.";
    const step: PlanStep = {
      id: "step-read-driver",
      index: 0,
      description: "Ler src/lib/db/driver.ts para analisar a persistência",
      objective: "Executar filesystem.read sem alterar arquivos",
      capability: "execucao_ferramenta",
      dependencies: [],
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
    };

    const result = await executeOneStep(step, task, analyzeTask(task), {
      runner: undefined,
      toolRegistry: registry,
      providers,
    });

    expect(result.observation.metadata.operation).toBe("read");
    expect(result.observation.output).toContain("DatabaseSync");
    expect(registry.getHistory().map((entry) => entry.result.metadata.operation)).not.toContain("write");
  });

  it("executa filesystem.write e filesystem.read em sequência para um arquivo temporário", async () => {
    const providers = buildProviders("gemini");
    const { createDefaultToolRegistry, getWorkspaceRoot } = await import("../src/adaptive/tools/registry.js");
    const registry = createDefaultToolRegistry({
      enableHistory: true,
      security: { fsRoot: getWorkspaceRoot() },
    });

    const writeTask = "Criar ./tmp/axon-test.txt com o conteúdo AXON_OK";
    const writeStep: PlanStep = {
      id: "step-write",
      index: 0,
      description: writeTask,
      objective: "escrever arquivo",
      capability: "execucao_ferramenta",
      dependencies: [],
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
    };

    const writeResult = await executeOneStep(writeStep, writeTask, analyzeTask(writeTask), {
      runner: undefined,
      toolRegistry: registry,
      providers,
      useTool: "filesystem",
    });

    expect(writeResult.observation.success).toBe(true);
    expect(writeResult.observation.metadata.operation).toBe("write");

    const readTask = "Ler ./tmp/axon-test.txt para confirmar o conteúdo";
    const readStep: PlanStep = {
      id: "step-read-2",
      index: 1,
      description: readTask,
      objective: "confirmar arquivo",
      capability: "execucao_ferramenta",
      dependencies: [],
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
    };

    const readResult = await executeOneStep(readStep, readTask, analyzeTask(readTask), {
      runner: undefined,
      toolRegistry: registry,
      providers,
      useTool: "filesystem",
    });

    expect(readResult.observation.success).toBe(true);
    expect(String(readResult.observation.output ?? "")).toContain("AXON_OK");
  });

  it("lista diretório real para src/routes", async () => {
    const providers = buildProviders("gemini");
    const { createDefaultToolRegistry, getWorkspaceRoot } = await import("../src/adaptive/tools/registry.js");
    const registry = createDefaultToolRegistry({
      enableHistory: true,
      security: { fsRoot: getWorkspaceRoot() },
    });

    const task = "Listar os arquivos de src/routes";
    const step: PlanStep = {
      id: "step-list",
      index: 0,
      description: task,
      objective: "mostrar conteúdo do diretório",
      capability: "execucao_ferramenta",
      dependencies: [],
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
    };

    const result = await executeOneStep(step, task, analyzeTask(task), {
      runner: undefined,
      toolRegistry: registry,
      providers,
      useTool: "filesystem",
    });

    expect(result.observation.success).toBe(true);
    expect(result.observation.metadata.operation).toBe("list");
    expect(String(result.observation.output ?? "")).toContain("models");
  });

  it("lista a raiz para pedido de listagem recursiva do workspace", async () => {
    const providers = buildProviders("gemini");
    const { createDefaultToolRegistry, getWorkspaceRoot } = await import("../src/adaptive/tools/registry.js");
    const registry = createDefaultToolRegistry({ security: { fsRoot: getWorkspaceRoot() } });
    const task = "Listar recursivamente todos os arquivos e diretórios do workspace atual";
    const step: PlanStep = {
      id: "step-workspace-list",
      index: 0,
      description: task,
      objective: "Executar listagem recursiva real",
      capability: "execucao_ferramenta",
      dependencies: [],
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
    };

    const result = await executeOneStep(step, task, analyzeTask(task), {
      toolRegistry: registry,
      providers,
    });

    expect(result.observation.success).toBe(true);
    expect(result.observation.metadata.operation).toBe("list");
    expect(result.observation.metadata.path).toBe(getWorkspaceRoot());
  });

  it("inspeciona workspace via list recursivo e passa no validator factual", async () => {
    const providers = buildProviders("gemini");
    const { createDefaultToolRegistry, getWorkspaceRoot } = await import("../src/adaptive/tools/registry.js");
    const registry = createDefaultToolRegistry({
      enableHistory: true,
      security: { fsRoot: getWorkspaceRoot() },
    });
    const task = "Analisar a estrutura atual do workspace para identificar frontend, backend e camada de persistência existentes.";
    const profile = analyzeTask(task);
    const step: PlanStep = {
      id: "workspace-list",
      index: 0,
      description: "Listar recursivamente a estrutura atual do workspace",
      objective: "Executar filesystem list na raiz do workspace",
      capability: "execucao_ferramenta",
      dependencies: [],
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
    };

    const result = await executeOneStep(step, task, profile, {
      runner: undefined,
      toolRegistry: registry,
      providers,
      useTool: "filesystem",
    });
    const evidence = JSON.parse(result.observation.output ?? "{}") as {
      tool?: string;
      action?: string;
      entries?: unknown[];
    };

    expect(profile.toolIntent).toBe("filesystem");
    expect(result.observation.toolName).toBe("filesystem");
    expect(result.observation.metadata.operation).toBe("list");
    expect(evidence).toMatchObject({ tool: "filesystem", action: "list" });
    expect(evidence.entries?.length ?? 0).toBeGreaterThan(0);

    const validation = await validateStep(task, step.description, result.observation, step.capability, {
      enableCritic: false,
      profile,
      providers,
    });
    expect(validation.passed).toBe(true);
  });

  it("completa o fluxo autônomo workspace → list filesystem → análise", async () => {
    const providers = buildProviders("gemini");
    const { createDefaultToolRegistry, getWorkspaceRoot } = await import("../src/adaptive/tools/registry.js");
    const registry = createDefaultToolRegistry({
      enableHistory: true,
      security: { fsRoot: getWorkspaceRoot() },
    });
    const task = "Analisar a estrutura atual do workspace identificando frontend, backend e camada de persistência.";
    const workspaceRunner = {
      complete: vi.fn().mockImplementation(async (request: ChatCompletionRequest) => {
        const system = request.messages.find((message) => message.role === "system")?.content ?? "";
        if (system.includes("PLANNER")) {
          return response(JSON.stringify({
            steps: [
              { id: "analysis", index: 0, description: "Analisar a estrutura encontrada", objective: "Interpretar a evidência listada", capability: "analise", dependencies: [], status: "pending" },
            ],
          }), request);
        }
        return response("A estrutura contém frontend, backend, persistência, testes e configurações identificáveis no workspace.", request);
      }),
    } satisfies LLMRunner;
    const profile = analyzeTask(task);
    const strategy = decideStrategy(profile);
    const decision = routeModel(profile, strategy.strategy, providers);

    const report = await runAutonomous(task, profile, strategy, decision, providers, {
      runner: workspaceRunner,
      toolRegistry: registry,
      persistMemory: false,
      budgets: { maxIterations: 6, maxCostUsd: 1, maxDurationMs: 30000 },
    });

    expect(report.stopReason).toBe("success");
    expect(report.stepLogs[0]?.capability).toBe("execucao_ferramenta");
    expect(report.stepLogs[0]?.validation.passed).toBe(true);
    expect(registry.getHistory().some((entry) => entry.toolName === "filesystem")).toBe(true);
    expect(workspaceRunner.complete).toHaveBeenCalledTimes(2);

    const analysisRequest = workspaceRunner.complete.mock.calls[1]?.[0] as ChatCompletionRequest;
    const analysisInput = analysisRequest.messages.map((message) => message.content).join("\n");
    expect(analysisInput).toContain("EVIDÊNCIAS REAIS DAS ETAPAS ANTERIORES");
    expect(analysisInput).toContain('"action":"list"');
    expect(analysisInput).toContain('"entries"');
  });

  it("preserva a evidência da listagem quando o LLM da análise usa fallback", async () => {
    const providers = buildProviders("gemini", "groq");
    const { createDefaultToolRegistry, getWorkspaceRoot } = await import("../src/adaptive/tools/registry.js");
    const registry = createDefaultToolRegistry({ security: { fsRoot: getWorkspaceRoot() } });
    const task = "Analisar a estrutura atual do workspace";
    const profile = analyzeTask(task);
    const step: PlanStep = {
      id: "workspace-analysis",
      index: 1,
      description: "Analisar a estrutura atual do workspace usando o filesystem",
      objective: "Interpretar a listagem real anterior",
      capability: "analise",
      dependencies: ["workspace-list"],
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
    };
    const evidence = JSON.stringify({
      tool: "filesystem",
      action: "list",
      path: getWorkspaceRoot(),
      entries: [{ path: "src", type: "directory" }],
    });
    const requests: ChatCompletionRequest[] = [];
    const runner = {
      complete: vi.fn().mockImplementation(async (request: ChatCompletionRequest) => {
        requests.push(request);
        if (requests.length === 1) {
          throw new ProviderHttpError("gemini 429", 429);
        }
        return response("Frontend em public e backend em src; persistência em src/lib/db.", request);
      }),
    } satisfies LLMRunner;

    const result = await executeOneStep(step, task, profile, {
      runner,
      toolRegistry: registry,
      providers,
      accumulatedContext: [`[Evidência da etapa 1 - execucao_ferramenta - filesystem]:\n${evidence}`],
    });

    expect(result.observation.success).toBe(true);
    expect(result.observation.output).toContain("Frontend");
    expect(requests[0]?.messages.map((message) => message.content).join("\n")).toContain(evidence);
    expect(requests[1]?.messages.map((message) => message.content).join("\n")).toContain(evidence);
  });
});