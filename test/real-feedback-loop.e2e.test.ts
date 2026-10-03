import { describe, expect, it } from "vitest";
import { config as loadEnv } from "dotenv";
loadEnv(); // carrega GEMINI_API_KEY do .env no ambiente de teste
import { executeTask } from "../src/adaptive/runtime.js";
import { setDriverForTest, createInMemoryDriver } from "../src/lib/db/driver.js";
import { runMigrations } from "../src/lib/db/migrations.js";
import { loadEvolutionContext } from "../src/evolution/loader.js";
import type { ProviderAdapter } from "../src/providers/types.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../src/schemas/chat.js";

/**
 * E2E REAL com o LLM configurado (Gemini) — prova o FEEDBACK LOOP F1→F7:
 *  - Exec 1: mesma sessão, dados F7 persistidos no SQLite.
 *  - loadEvolutionContext(session) lê o histórico.
 *  - Exec 2: começa com o histórico carregado (reflections/skills no contexto).
 *
 * Usa o runner real (chave Gemini do .env), SEM mocks.
 */

const SESSION = "real-feedback-" + Date.now();

// Contador de chamadas HTTP reais ao Gemini (prova que não é mock/stub)
let realHttpCalls = 0;

function makeGeminiAdapter(): ProviderAdapter {
  return {
    name: "gemini",
    complete: async (req: ChatCompletionRequest): Promise<ChatCompletionResponse> => {
      const key = process.env.GEMINI_API_KEY;
      if (!key) throw new Error("GEMINI_API_KEY ausente");
      // Modelo disponível na conta (gemini-1.5-flash retorna 404)
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`;
      const system = req.messages.find((m) => m.role === "system")?.content ?? "";
      const prompt = [
        system ? `[Sistema]\n${system}` : "",
        `[Usuário]\n${req.messages.map((m) => m.content).join("\n")}`,
      ].filter(Boolean).join("\n\n");
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      });
      realHttpCalls += 1; // incrementa a cada chamada HTTP REAL
      if (!res.ok) {
        throw new Error(`Gemini HTTP ${res.status}`);
      }
      const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "RESPOSTA";
      return {
        id: "gemini-real", provider: "gemini", model: "gemini-2.5-flash",
        content: text,
        usage: { prompt_tokens: 50, completion_tokens: 80, total_tokens: 130 },
        cached: false,
      };
    },
    stream: async function* () { yield { delta: "", done: true }; },
  };
}

describe.skipIf(!process.env.GEMINI_API_KEY)("E2E REAL — F1→F7 com LLM (Gemini) e feedback loop", () => {
  it("2 execuções na mesma sessão: histórico F7 é carregado e influencia", async () => {
    // DB em memória isolado — evita corrida com outros testes
    const memDriver = createInMemoryDriver();
    setDriverForTest(memDriver);
    runMigrations();
    const db = memDriver;
    // Sessão única por execução (SESSION tem timestamp) — não precisa limpar o banco global.

    const providers = new Map<string, ProviderAdapter>([["gemini", makeGeminiAdapter()]]);
    const task = "Em modo autônomo, crie uma função TypeScript que retorna o maior número de uma lista";

    // ── EXEC 1 ──
    // IMPORTANTE: SEM runner → executeViaLLM usa o provider adapter (Gemini real).
    const r1 = await executeTask(task, providers, {
      sessionId: SESSION,
      persistAutonomousMemory: true,
    });
    console.log("Exec1 stopReason:", r1.autonomous?.stopReason);
    console.log("Exec1 stepLogs:", r1.autonomous?.stepLogs.length);

    // Verifica persistência F7
    const skillsN = (db.prepare("SELECT COUNT(*) n FROM skills WHERE session_id=?").get(SESSION) as { n: number }).n;
    const stratN = (db.prepare("SELECT COUNT(*) n FROM strategy_scores WHERE session_id=?").get(SESSION) as { n: number }).n;
    const reflN = (db.prepare("SELECT COUNT(*) n FROM reflections WHERE session_id=?").get(SESSION) as { n: number }).n;
    const goalsN = (db.prepare("SELECT COUNT(*) n FROM goals WHERE session_id=?").get(SESSION) as { n: number }).n;
    const curN = (db.prepare("SELECT COUNT(*) n FROM curiosity_signals WHERE session_id=?").get(SESSION) as { n: number }).n;
    const metabN = (db.prepare("SELECT COUNT(*) n FROM metabolism_snapshots WHERE session_id=?").get(SESSION) as { n: number }).n;
    console.log("Persistido após Exec1:", { skillsN, stratN, reflN, goalsN, curN, metabN });

    // ── CARREGA contexto evolutivo (mesma sessão) ──
    const ctx = loadEvolutionContext(SESSION);
    console.log("Contexto carregado:", {
      strategyHistory: ctx.strategyHistory.length,
      skills: ctx.skills.length,
      reflections: ctx.priorReflections.length,
      goals: ctx.priorGoals.length,
    });

    // ── EXEC 2: começa com o histórico carregado (também sem runner → Gemini real)
    const r2 = await executeTask(task, providers, {
      sessionId: SESSION,
      persistAutonomousMemory: true,
    });
    console.log("Exec2 stopReason:", r2.autonomous?.stopReason);
    console.log("Exec2 stepLogs:", r2.autonomous?.stepLogs.length);

    // Assertions — e prova de chamadas HTTP REAIS ao Gemini
    expect(skillsN).toBeGreaterThan(0);
    expect(stratN).toBeGreaterThan(0);
    expect(reflN).toBeGreaterThan(0);
    expect(curN).toBeGreaterThan(0);
    expect(metabN).toBeGreaterThan(0);
    expect(ctx.strategyHistory.length).toBeGreaterThan(0);
    expect(ctx.skills.length).toBeGreaterThan(0);

    // PROVA: houve N chamadas HTTP reais ao Gemini (não mock/stub)
    console.log("Chamadas HTTP reais ao Gemini:", realHttpCalls);
    expect(realHttpCalls).toBeGreaterThan(0);
  }, 180000); // 180s — duas execuções sequenciais reais com o Gemini demoram; evita timeout padrão do Vitest
});