import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setDriverForTest, createInMemoryDriver } from "../src/lib/db/driver.js";
import { runMigrations } from "../src/lib/db/migrations.js";
import { registerArtifact } from "../src/adaptive/artifacts.js";
import { executeTask, type LLMRunner } from "../src/adaptive/runtime.js";
import { SqliteSessionStore } from "../src/adaptive/memory.js";
import type { ProviderAdapter } from "../src/providers/types.js";
import type { ChatCompletionResponse } from "../src/schemas/chat.js";

let workspaceDir: string;
let previousWorkspace: string | undefined;

beforeAll(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "axon-session-e2e-"));
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

beforeEach(() => {
  setDriverForTest(createInMemoryDriver());
  runMigrations();
});

function fakeAdapter(provider: string): ProviderAdapter {
  return { name: provider as ProviderAdapter["name"], complete: vi.fn(), stream: vi.fn() };
}
function buildProviders(...names: string[]): Map<string, ProviderAdapter> {
  const map = new Map<string, ProviderAdapter>();
  for (const name of names) map.set(name, fakeAdapter(name));
  return map;
}
function capturingRunner(reply: string): { runner: LLMRunner; mock: ReturnType<typeof vi.fn> } {
  const mock = vi.fn().mockResolvedValue({
    id: "r1",
    provider: "groq",
    model: "openai/gpt-oss-20b",
    content: reply,
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    cached: false,
  } satisfies ChatCompletionResponse);
  return { runner: { complete: mock as LLMRunner["complete"] }, mock };
}

/**
 * Reproduz o cenário EXATO do relatório do usuário:
 * 1. Envia um zip -> analisado.
 * 2. "tem como melhorar o projeto atual?" -> antes perguntava qual projeto;
 *    agora o contexto do artefato precisa chegar no prompt do LLM.
 * 3. Depois de gerar um zip novo, "como faço pra executar?" -> idem.
 */
describe("sessão com artefatos — cenário completo do relatório do usuário", () => {
  it("'o projeto atual' chega resolvido no prompt do LLM após analisar um zip enviado", async () => {
    const sessionId = "sessao-relato-1";

    registerArtifact({
      sessionId,
      name: "axon-corrigido6.zip",
      type: "uploaded_zip",
      workspacePath: "axon-corrigido6.zip",
    });
    registerArtifact({
      sessionId,
      name: "axon-corrigido6_extracted",
      type: "extracted_dir",
      workspacePath: "axon-corrigido6_extracted",
      parentArtifactPath: "axon-corrigido6.zip",
    });

    const { runner, mock } = capturingRunner("Sim! Sugiro X, Y e Z para o projeto.");
    const report = await executeTask("tem como melhorar o projeto atual?", buildProviders("groq"), {
      runner,
      sessionId,
    });

    expect(report.strategy.strategy).toBe("single_agent");
    const sentPrompt = (mock.mock.calls[0]?.[0] as { messages: { content: string }[] }).messages[0]!.content;

    expect(sentPrompt).toContain("Projeto atual");
    expect(sentPrompt).toContain("axon-corrigido6_extracted");
    expect(sentPrompt).toContain("tem como melhorar o projeto atual?");
  });

  it("'como faço pra executar?' resolve para o zip gerado mais recentemente, mesmo sem nomeá-lo", async () => {
    const sessionId = "sessao-relato-2";

    registerArtifact({ sessionId, name: "axon-corrigido6.zip", type: "uploaded_zip", workspacePath: "axon-corrigido6.zip" });
    registerArtifact({
      sessionId,
      name: "simple-flask-web.zip",
      type: "generated_zip",
      workspacePath: "simple-flask-web.zip",
      parentArtifactPath: "axon-corrigido6.zip",
    });

    const { runner, mock } = capturingRunner("Para rodar: docker build . && docker run -p 5000:5000 ...");
    const report = await executeTask("como faço pra executar?", buildProviders("groq"), { runner, sessionId });

    expect(report.strategy.strategy).toBe("single_agent");
    const sentPrompt = (mock.mock.calls[0]?.[0] as { messages: { content: string }[] }).messages[0]!.content;
    expect(sentPrompt).toContain("simple-flask-web.zip");
    expect(sentPrompt).toContain("como faço pra executar?");
  });

  it("sem nenhum artefato registrado, o prompt não ganha bloco de contexto (comportamento inalterado)", async () => {
    const { runner, mock } = capturingRunner("resposta qualquer");
    await executeTask("oi, tudo bem?", buildProviders("groq"), { runner, sessionId: "sessao-nova-sem-nada" });

    const sentPrompt = (mock.mock.calls[0]?.[0] as { messages: { content: string }[] }).messages[0]!.content;
    expect(sentPrompt).toBe("oi, tudo bem?");
  });

  it("funciona combinado com SqliteSessionStore (histórico de texto + contexto de artefato juntos)", async () => {
    const sessionId = "sessao-combinada";
    const store = new SqliteSessionStore();
    registerArtifact({ sessionId, name: "projeto.zip", type: "uploaded_zip", workspacePath: "projeto.zip" });

    const { runner: r1 } = capturingRunner("Analisei o projeto: é uma API Flask simples.");
    await executeTask("analise este zip", buildProviders("groq"), { runner: r1, sessionId, sessionStore: store });

    const { runner: r2, mock: mock2 } = capturingRunner("Sugiro adicionar testes.");
    await executeTask("o que você melhoraria?", buildProviders("groq"), { runner: r2, sessionId, sessionStore: store });

    const sentPrompt = (mock2.mock.calls[0]?.[0] as { messages: { content: string }[] }).messages[0]!.content;
    expect(sentPrompt).toContain("projeto.zip");
    expect(sentPrompt).toContain("Analisei o projeto");
    expect(sentPrompt).toContain("o que você melhoraria?");
  });
});
