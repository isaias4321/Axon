import "dotenv/config";
import { setDriverForTest, getDriver } from "../src/lib/db/driver.js";
import { loadEvolutionContext, weakCapabilities, prioritizeStrategies } from "../src/evolution/loader.js";

/**
 * PROCESSO 2 — processo NOVO que lê o SQLite gravado pelo Processo 1.
 * NÃO herda estado em memória; lê do arquivo no disco (~/.axon/autonomous.db).
 * Uso: node scripts/p2-le-feedback.mjs
 */
const SESSION = "cross-process-session";

function main(): void {
  // driver NOVO neste processo — o driver do Processo 1 não existe mais.
  setDriverForTest(null);
  getDriver(); // abre/garante o arquivo no disco

  const ctx = loadEvolutionContext(SESSION);

  console.log("[P2] Contexto carregado de um NOVO processo:");
  console.log("[P2]   strategyHistory:", ctx.strategyHistory.length);
  console.log("[P2]   skills:", ctx.skills.length);
  console.log("[P2]   recurringErrors:", ctx.recurringErrors.length);
  console.log("[P2]   priorReflections:", ctx.priorReflections.length);
  console.log("[P2]   energyHistory:", ctx.energyHistory.length);
  console.log("[P2]   priorGoals:", ctx.priorGoals.length);

  // Demonstra que o histórico INFLUENCIA uma decisão:
  console.log("[P2] Prioridade das estratégias (do histórico):",
    prioritizeStrategies(ctx, 1).map((p) => `${p.strategy}=${p.priority.toFixed(4)}`).join(", ") || "nenhuma");

  console.log("[P2] Capacidades fracas no histórico:", weakCapabilities(ctx, 0.6).join(", ") || "nenhuma");

  // Critério de sucesso: o processo 2 deve ter lido > 0 registros do disco.
  if (ctx.strategyHistory.length === 0) {
    console.error("[P2] FALHA: nenhum strategy_history lido do disco.");
    process.exit(1);
  }
  console.log("[P2] OK — histórico lido do SQLite em um NOVO processo.");
}

main();