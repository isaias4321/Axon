import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";

import { runAutonomous } from "../src/adaptive/autonomous.js";
import { analyzeTask } from "../src/adaptive/taskAnalyzer.js";
import { decideStrategy } from "../src/adaptive/strategyEngine.js";
import { routeModel } from "../src/adaptive/modelRouter.js";
import type { ProviderAdapter } from "../src/providers/types.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../src/schemas/chat.js";
import type { LLMRunner } from "../src/adaptive/runtime.js";

function fakeAdapter(provider: string): ProviderAdapter {
  return { name: provider as ProviderAdapter["name"], complete: vi.fn(), stream: vi.fn() };
}

function buildProviders(...names: string[]): Map<string, ProviderAdapter> {
  return new Map(names.map((name) => [name, fakeAdapter(name)]));
}

const SYNTHESIZED_FALLBACK_TEXT =
  "Consegui listar o conteúdo de projeto.zip, mas não encontrei um README.md dentro dele para detalhar mais o propósito do projeto.";

/**
 * Runner determinístico: identifica o papel da chamada pelo system prompt
 * (mesmo padrão usado em autonomous-integration.test.ts). O plano tem DUAS
 * etapas de tool: a primeira (listar um zip real) SEMPRE sucede; a segunda
 * (ler um README que não existe no workspace de teste) SEMPRE falha — isso
 * reproduz exatamente a forma do bug real (uma etapa de tool passa antes de
 * travar em no_progress numa etapa seguinte).
 */
function scriptedRunner(): LLMRunner {
  return {
    complete: vi.fn(async (request: ChatCompletionRequest): Promise<ChatCompletionResponse> => {
      const system = request.messages.find((m) => m.role === "system")?.content ?? "";

      if (system.includes("PLANNER")) {
        return {
          id: "r",
          provider: request.provider,
          model: request.model,
          content: JSON.stringify({
            steps: [
              {
                id: "s1",
                index: 0,
                description: "Listar o conteúdo do arquivo projeto.zip",
                objective: "Ver o que tem dentro do zip",
                capability: "execucao_ferramenta",
                dependencies: [],
                status: "pending",
              },
              {
                id: "s2",
                index: 1,
                description: "Ler o arquivo README.md do projeto",
                objective: "Entender o propósito do projeto",
                capability: "execucao_ferramenta",
                dependencies: ["s1"],
                status: "pending",
              },
            ],
          }),
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
          cached: false,
        };
      }

      if (system.includes("CRITIC")) {
        return {
          id: "r",
          provider: request.provider,
          model: request.model,
          content: JSON.stringify({ passed: true, confidence: 0.9, issues: [], suggestedCorrection: null }),
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          cached: false,
        };
      }

      // Qualquer outra chamada (inclui a síntese do fallback final, que não
      // tem marcador de papel no system prompt) devolve o texto sintetizado.
      return {
        id: "r",
        provider: request.provider,
        model: request.model,
        content: SYNTHESIZED_FALLBACK_TEXT,
        usage: { prompt_tokens: 15, completion_tokens: 25, total_tokens: 40 },
        cached: false,
      };
    }),
  };
}

describe("REGRESSÃO — finalResult poluído por output bruto de etapa anterior bem-sucedida", () => {
  let workspaceDir: string;

  it("quando uma etapa de tool passa e uma etapa seguinte trava em no_progress, a resposta final é sintetizada em texto — nunca o JSON bruto da etapa anterior", async () => {
    workspaceDir = mkdtempSync(join(tmpdir(), "axon-finalresult-test-"));
    try {
      // Um zip de verdade, para a etapa 1 (listar) genuinamente suceder.
      const zip = new AdmZip();
      zip.addFile("app.py", Buffer.from("print('oi')"));
      zip.writeZip(join(workspaceDir, "projeto.zip"));
      // SEM README.md no workspace — a etapa 2 (ler) falha de verdade.

      const task = "analise este arquivo e me diga oq este projeto faz";
      const profile = analyzeTask(task);
      const strategy = decideStrategy(profile);
      const providers = buildProviders("groq");
      const decision = routeModel(profile, strategy.strategy, providers);

      const report = await runAutonomous(task, profile, strategy, decision, providers, {
        runner: scriptedRunner(),
        toolSecurity: { fsRoot: workspaceDir },
        budgets: { maxIterations: 6 },
      });

      expect(report.stopReason).toBe("no_progress");

      // O bug real: finalResult virava o JSON bruto da etapa 1
      // ({"tool":"compression","action":"list",...}) em vez de passar pela
      // síntese. Com a correção, finalResult é SEMPRE a resposta sintetizada
      // quando o loop termina em no_progress/failure.
      expect(report.finalResult).not.toMatch(/^\{"tool":/);
      expect(report.finalResult).toBe(SYNTHESIZED_FALLBACK_TEXT);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});
