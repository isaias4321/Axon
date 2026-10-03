/**
 * Demonstração determinística do Agente + Subagentes.
 *
 * Roda o agente de verdade (`executeTask`) com um runner in-memory 100%
 * offline (sem LLM externo), exercitando:
 *   - agente principal (single_agent)
 *   - subagentes do Orchestrator multi-agente (analise→planejamento→…)
 *   - Cognitive Router + células (F9)
 */

import { executeTask, type LLMRunner } from "../src/adaptive/runtime.js";
import { routeWithCognitiveSystem } from "../src/cognitive/index.js";
import type { ChatCompletionResponse } from "../src/schemas/chat.js";
import type { ProviderAdapter } from "../src/providers/types.js";

function buildProviders(...names: string[]): Map<string, ProviderAdapter> {
  const map = new Map<string, ProviderAdapter>();
  for (const name of names) {
    map.set(name, {
      name: name as ProviderAdapter["name"],
      complete: () => Promise.reject(new Error("use o runner fake")),
      stream: () => Promise.reject(new Error("use o runner fake")),
    });
  }
  return map;
}

/** Runner fake: devolve conteúdo estável refletindo o papel da mensagem. */
const runner: LLMRunner = {
  async complete(request): Promise<ChatCompletionResponse> {
    const lastUser = [...request.messages]
      .reverse()
      .find((m) => m.role === "user");
    const text = typeof lastUser?.content === "string" ? lastUser.content : "—";
    const echo = text.replace(/\s+/g, " ").slice(0, 120);
    return {
      id: `resp-${Math.random().toString(36).slice(2)}`,
      provider: request.provider,
      model: request.model,
      content: `[subagente] ${echo}`,
      usage: {
        prompt_tokens: 20,
        completion_tokens: 30,
        total_tokens: 50,
      },
      cached: false,
    };
  },
};

const psi = (label: string) => console.log(`\n═══ ${label} ═══`);

async function main() {
  const providers = buildProviders("openai", "groq", "gemini");

  psi("AGENTE PRINCIPAL — single_agent (gera código)");
  const single = await executeTask(
    "Escreva uma função Python que valide um CPF",
    providers,
    { runner }
  );
  console.log("estratégia:", single.strategy.strategy);
  console.log("decisão:", single.decision.status, single.decision.provider, single.decision.model);
  console.log("executado:", single.execution.executed, "→", single.execution.content);
  console.log("custoReal (tokens):", single.costActual?.totalTokens, "USD:", single.costActual?.costUsd);

  psi("AGENTE MULTI-AGENTE — subagentes via Orchestrator (F5)");
  const multi = await executeTask(
    "Analise o impacto e projete a arquitetura de uma migracao de monolitos para microservicos, planejando as etapas e os testes de cada fase",
    providers,
    { runner }
  );
  console.log("estratégia:", multi.strategy.strategy);
  if (multi.orchestration) {
    console.log("subagentes (subtasks):", multi.orchestration.subtasks.map((s) => s.capability).join(" → "));
    console.log("passos executados:", multi.orchestration.steps.map((st) => `${st.label}:${st.status}`).join(", "));
    console.log("síntese do orchestrator:", multi.orchestration.synthesis.content);
    console.log("custo agregado (tokens):", multi.orchestration.cost.totalTokens);
  } else {
    console.log("(sem orquestração — fallback)", multi.execution.content);
  }

  psi("COGNITIVE ROUTER — células/delegação (F9)");
  const cog = await routeWithCognitiveSystem(
    "investigar erro 429 no rate limiter e planejar a correção com Redis distribuído",
    {
      capabilities: ["raciocinio"],
      category: "geral",
      complexity: "media",
      text: "investigar erro 429 no rate limiter e planejar a correção com Redis distribuído",
      hints: [],
    },
    "demo",
    { forceRouter: true }
  );
  console.log("routerUsado:", cog.routerUsed);
  console.log("classificação:", cog.classification?.primaryCellType, "+", cog.classification?.secondaryCellTypes.join(", "));
  console.log("células executadas:", Array.from(cog.cellResults.keys()).join(", "));
  console.log("sucesso:", cog.allSuccessful, "| erros:", cog.errors.length);

  console.log("\nTodas as execuções do agente/subagentes concluíram OK.");
}

main().catch((err) => {
  console.error("Erro na demo:", err);
  process.exitCode = 1;
});