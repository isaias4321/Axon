/**
 * Fase 9.1 — Diagnóstico E2E fora do Vitest (ETAPA 4/5 da auditoria).
 *
 * Executa o MESMO fluxo dos testes fase9.1 com instrumentação completa:
 *   Task → classificação (determinística) → CognitiveRouter → célula primária
 *   → células secundárias → ToolRegistry → memória/contexto → resultado
 *
 * Prova também:
 *   - classificação 100% determinística (duas chamadas = mesmo resultado);
 *   - zero dependência de classificador externo/LLM/rede.
 */

import { createCognitiveSystem } from "../src/cognitive/index.js";
import { analyzeTask } from "../src/adaptive/taskAnalyzer.js";
import { createCognitiveToolRegistry } from "../src/cognitive/tools/index.js";

const TASK =
  "Investigar um erro 429 no rate limiter, localizar a implementação responsável, diagnosticar a causa e produzir um plano de correção.";

const t0 = performance.now();
const log = (label: string, value?: unknown) =>
  console.log(`\n[${label}]`, value === undefined ? "" : JSON.stringify(value, null, 2));

async function main(): Promise<void> {
  const system = createCognitiveSystem({ sessionId: "debug-f91" });
  const profile = analyzeTask(TASK);

  // ── 1. Classificação (determinística, sem LLM/rede) ────────────────
  const ctxBase = {
    sessionId: "debug-f91",
    taskId: "debug-f91:t1",
    taskProfile: {
      capabilities: ["raciocinio"],
      category: "geral",
      complexity: "media",
    },
    budgets: {
      maxTokens: 50000,
      maxDurationMs: 60000,
      maxToolCalls: 20,
      maxCostUsd: 0.1,
    },
    sandboxConfig: {
      fsRoot: process.env.DATA_DIR ?? "~/.axon",
      allowedTools: ["filesystem", "shell", "http", "grep"],
      allowShell: true,
      allowHttp: true,
      allowedEnvVars: [],
    },
    availableTools: ["filesystem", "shell", "http", "grep"],
    cognitiveMemory: system.memory,
  };

  const cls1 = await system.router.classifyIntent(TASK, ctxBase);
  const cls2 = await system.router.classifyIntent(TASK, ctxBase);
  const deterministic = JSON.stringify(cls1) === JSON.stringify(cls2);

  log("CLASSIFICAÇÃO (intent)", {
    primaryCellType: cls1.primaryCellType,
    secondaryCellTypes: cls1.secondaryCellTypes,
    confidence: Number(cls1.confidence.toFixed(3)),
    entities: cls1.entities.map((e) => ({ type: e.type, value: e.value })),
    reasoning: cls1.reasoning,
  });
  log("DETERMINISMO", { duasChamadasIguais: deterministic });

  // ── 2. Dispatch pelo CognitiveRouter ───────────────────────────────
  const ctx = {
    ...ctxBase,
    taskProfile: {
      ...ctxBase.taskProfile,
      capabilities: profile.capabilities,
      category: profile.category,
      complexity: profile.complexity,
      text: TASK,
      hints: [],
      wordCount: TASK.split(/\s+/).length,
      charCount: TASK.length,
    },
  };
  const routed = await system.router.route(TASK, ctx);

  log("CÉLULAS EXECUTADAS", Array.from(routed.results.keys()));
  log("RESULTADO POR CÉLULA", Array.from(routed.results.entries()).map(([id, out]) => ({
    cellId: id,
    cellType: out.provenance?.cellType,
    success: out.success,
    error: out.error?.message ?? null,
    dataKeys: out.data && typeof out.data === "object" ? Object.keys(out.data) : [],
    amostra: summarize(out.data),
  })));
  log("MENSAGENS INTER-CELL (barramento)", routed.messages.length);
  log("ALL_SUCCESSFUL", routed.allSuccessful);
  log("ERROS", routed.errors.map((e) => e.message));

  // ── 3. Memória / contexto compartilhado ────────────────────────────
  const keys = await system.memory.list("cognitive:debug-f91");
  log("MEMÓRIA COMPARTILHADA (chaves)", keys);
  for (const key of keys.slice(0, 5)) {
    const entry = await system.memory.get(key);
    log(`MEMÓRIA[${key}]`, entry?.value);
  }

  // ── 4. ToolRegistry (mesma factory usada pelo router) ──────────────
  const registry = createCognitiveToolRegistry();
  log("TOOLREGISTRY (tools registradas)", registry.list());
  const grepResult = await registry.execute<{ pattern: string; path: string; maxResults: number }>("grep", {
    pattern: "429",
    path: "./src",
    maxResults: 3,
  });
  log("TOOLREGISTRY (grep '429' em ./src)", {
    success: grepResult.success,
    duracaoMs: grepResult.durationMs,
    outputPreview: grepResult.output?.slice(0, 160) ?? null,
    error: grepResult.error,
  });

  log("DURAÇÃO TOTAL (ms)", Math.round(performance.now() - t0));

  console.log("\n=== VEREDITO ===");
  console.log("Fluxo Router→Cells→Memória executou sem erro:", routed.allSuccessful);
  console.log("Classificador determinístico (sem classificador externo):", deterministic);

  // ── 5. Cenário 2: ResearchCell com ferramenta real ─────────────────
  const researchTask = "pesquisar como o rate limiter limita as requisições no código";
  const routedResearch = await system.router.route(researchTask, {
    ...ctx,
    taskId: "debug-f91:t2",
  });
  log("CENÁRIO 2 (research): CÉLULAS EXECUTADAS", Array.from(routedResearch.results.keys()));
  log("CENÁRIO 2: RESULTADO POR CÉLULA", Array.from(routedResearch.results.entries()).map(([id, out]) => ({
    cellId: id,
    cellType: out.provenance?.cellType,
    success: out.success,
    dataKeys: out.data && typeof out.data === "object" ? Object.keys(out.data) : [],
    amostra: summarize(out.data),
  })));
}

function summarize(data: unknown): unknown {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  const diag = obj.diagnosis as { errorType?: string } | undefined;
  if (diag) return { diagnosisErrorType: diag.errorType ?? null };
  if (Array.isArray(obj.plan)) return { planSteps: obj.plan.length };
  if (Array.isArray(obj.findings)) return { findings: obj.findings.length };
  if (Array.isArray(obj.values)) return { values: obj.values.length };
  return null;
}

main().catch((err: unknown) => {
  console.error("ERRO NO DIAGNÓSTICO:", err);
  process.exitCode = 1;
});