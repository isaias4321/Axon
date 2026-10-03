/**
 * Verificação de INTERAÇÃO entre as fases:
 *   F9   (células + router + ToolRegistry + memória)
 *   F9.1 (routeWithCognitiveSystem — entry point da rota HTTP e do useCognitive)
 *   F9.2 (supervisor: DebugCell → requestCell(research) → grep real)
 *
 * Prova que a API pública da F9.1 dispara automaticamente a cooperação da F9.2.
 */

import { routeWithCognitiveSystem } from "../src/cognitive/index.js";
import { analyzeTask } from "../src/adaptive/taskAnalyzer.js";
import { resolve } from "node:path";

const task =
  "Investigue o erro 429 do rate limiter do gateway e produza um plano de correcao.";

async function main(): Promise<void> {
  // DATA_DIR aponta para ./src para o grep real encontrar código
  process.env.DATA_DIR = resolve("./src");

  const result = await routeWithCognitiveSystem(
    task,
    { ...analyzeTask(task), text: task },
    "interact-fases",
    { forceRouter: true }
  );

  const debug = result.cellResults.get("debug-cell-1");
  const diag = (debug?.data ?? {}) as {
    diagnosis?: { evidence?: Array<{ description?: string }> };
  };
  const viaResearch = (diag.diagnosis?.evidence ?? []).filter((e) =>
    String(e.description ?? "").includes("[via ResearchCell]")
  );

  console.log("F9.1 routerUsed:", result.routerUsed);
  console.log(
    "F9.1 classificacao:",
    result.classification?.primaryCellType,
    "+",
    JSON.stringify(result.classification?.secondaryCellTypes)
  );
  console.log("Celulas executadas:", Array.from(result.cellResults.keys()).join(", "));
  console.log("allSuccessful:", result.allSuccessful, "| erros:", result.errors.length);
  console.log(
    "F9.2 delegacao visivel no diagnostico ([via ResearchCell]):",
    viaResearch.length > 0 ? `${viaResearch.length} evidencia(s)` : "NENHUMA"
  );
  if (viaResearch[0]) {
    console.log("Exemplo:", JSON.stringify(viaResearch[0]).slice(0, 160));
  }

  const interacaoOK = result.routerUsed && result.allSuccessful && viaResearch.length > 0;
  console.log("\n=== INTERACAO F9 <-> F9.1 <-> F9.2:", interacaoOK ? "OK" : "FALHOU", "===");
  if (!interacaoOK) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error("ERRO:", err);
  process.exitCode = 1;
});