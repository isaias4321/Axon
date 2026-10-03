import Fastify from "fastify";
import { afterAll, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import type { LLMRunner } from "../src/adaptive/runtime.js";
import authPlugin from "../src/plugins/auth.js";
import type { ProviderAdapter } from "../src/providers/types.js";
import type { ChatCompletionResponse } from "../src/schemas/chat.js";
import runRoute from "../src/routes/run.js";
import providerHealthRoute from "../src/routes/providerHealth.js";

const VALID_KEY = "test-key";
const WORKSPACE = process.cwd();

function fakeAdapter(provider: string): ProviderAdapter {
  return {
    name: provider as ProviderAdapter["name"],
    complete: vi.fn(),
    stream: vi.fn(),
  };
}

/**
 * Runner fake que responde como o PLANNER: um plano JSON com UMA etapa
 * descrevendo a criação real do arquivo. O resto do fluxo (decisão de tool,
 * execução real da ferramenta, read-back e validação) é 100% real — só o LLM
 * é injetado, seguindo o mesmo padrão dos demais testes do projeto.
 */
function plannerRunner(planJson: string): LLMRunner {
  return {
    complete: vi.fn().mockImplementation(async () => {
      return {
        id: "resp-plan",
        provider: "gemini",
        model: "gemini-2.5-flash",
        content: planJson,
        cached: false,
      } satisfies ChatCompletionResponse;
    }),
  };
}

function buildTestApp(runner: LLMRunner) {
  const fastify = Fastify({ logger: false });
  const map = new Map<string, ProviderAdapter>();
  map.set("gemini", fakeAdapter("gemini"));

  fastify.register(authPlugin, { validKeys: [VALID_KEY] });
  fastify.register(runRoute, { providers: map, runner });
  return fastify;
}

const USER_TASK =
  "Crie um arquivo hello.txt contendo exatamente: Hello from Axon";

const PLAN = JSON.stringify({
  steps: [
    {
      id: "step-1",
      index: 0,
      description: "Criar o arquivo hello.txt com o conteúdo Hello from Axon",
      objective: "Criar o arquivo hello.txt contendo Hello from Axon",
      capability: "execucao_ferramenta",
      dependencies: [],
      status: "pending",
    },
  ],
});

describe("E2E — execução REAL de ferramenta via /v1/run", () => {
  const filePath = join(WORKSPACE, "hello.txt");

  afterAll(() => {
    if (existsSync(filePath)) rmSync(filePath);
  });

  it("executa a ferramenta filesystem de verdade, cria o arquivo e valida o conteúdo", async () => {
    if (existsSync(filePath)) rmSync(filePath);

    const fastify = buildTestApp(plannerRunner(PLAN));
    const response = await fastify.inject({
      method: "POST",
      url: "/v1/run",
      headers: { "x-api-key": VALID_KEY },
      payload: { task: USER_TASK },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      execution: { executed: boolean; content: string | null; error: string | null };
      autonomous?: { stopReason: string; iterations: number };
    };

    expect(body.execution.executed).toBe(true);
    expect(body.execution.error).toBeNull();

    // O arquivo DEVE existir DE VERDADE, na raiz do workspace, com o conteúdo pedido.
    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, "utf-8");
    expect(content).toBe("Hello from Axon");

    // O loop autônomo deve ter terminado com sucesso usando a ferramenta.
    expect(body.autonomous?.stopReason).toBe("success");

    await fastify.close();
  });

  it("não finge sucesso quando a ferramenta falha (caminho fora do workspace)", async () => {
    const badTask = "Crie um arquivo ../fora-do-workspace.txt contendo teste";
    const fastify = buildTestApp(plannerRunner(PLAN));
    const response = await fastify.inject({
      method: "POST",
      url: "/v1/run",
      headers: { "x-api-key": VALID_KEY },
      payload: { task: badTask },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      execution: { executed: boolean; content: string | null; error: string | null };
      autonomous?: { stopReason: string; error: string | null };
    };

    // O arquivo NÃO pode existir fora do workspace...
    expect(existsSync(resolve(WORKSPACE, "..", "fora-do-workspace.txt"))).toBe(false);
    // ...e o agente NÃO pode relatar sucesso.
    const failed = !body.execution.executed || body.autonomous?.stopReason !== "success";
    expect(failed).toBe(true);

    await fastify.close();
  });
});

describe("GET /v1/providers/health", () => {
  it("lista provedores do catálogo com status real (configurado vs não configurado)", async () => {
    const fastify = Fastify({ logger: false });
    const map = new Map<string, ProviderAdapter>();
    map.set("gemini", fakeAdapter("gemini"));

    fastify.register(authPlugin, { validKeys: [VALID_KEY] });
    fastify.register(providerHealthRoute, { providers: map });

    const response = await fastify.inject({
      method: "GET",
      url: "/v1/providers/health",
      headers: { "x-api-key": VALID_KEY },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      providers: Array<{
        provider: string;
        configured: boolean;
        status: string;
        models: string[];
        error?: string;
      }>;
    };

    const names = body.providers.map((p) => p.provider);
    expect(names).toContain("gemini");
    expect(names).toContain("openai");

    const gemini = body.providers.find((p) => p.provider === "gemini")!;
    expect(gemini.configured).toBe(true);
    expect(gemini.status).toBe("connected");
    expect(gemini.models.length).toBeGreaterThan(0);

    const openai = body.providers.find((p) => p.provider === "openai")!;
    expect(openai.configured).toBe(false);
    expect(openai.status).toBe("not_configured");

    await fastify.close();
  });

  it("filtra por ?provider=", async () => {
    const fastify = Fastify({ logger: false });
    const map = new Map<string, ProviderAdapter>();
    map.set("gemini", fakeAdapter("gemini"));

    fastify.register(authPlugin, { validKeys: [VALID_KEY] });
    fastify.register(providerHealthRoute, { providers: map });

    const response = await fastify.inject({
      method: "GET",
      url: "/v1/providers/health?provider=groq",
      headers: { "x-api-key": VALID_KEY },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { providers: Array<{ provider: string }> };
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0]!.provider).toBe("groq");

    await fastify.close();
  });
});