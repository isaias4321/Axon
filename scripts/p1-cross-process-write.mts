import "dotenv/config";
import { executeTask } from "../src/adaptive/runtime.js";
import { setDriverForTest, getDriver } from "../src/lib/db/driver.js";
import { runMigrations } from "../src/lib/db/migrations.js";
import type { ProviderAdapter } from "../src/providers/types.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../src/schemas/chat.js";

/**
 * PROCESSO 1 — grava uma experiência no SQLite.
 * Uso: node scripts/p1-escreve-experiencia.mjs
 */
const SESSION = "cross-process-session";

function makeGeminiAdapter(): ProviderAdapter {
  return {
    name: "gemini",
    complete: async (req: ChatCompletionRequest): Promise<ChatCompletionResponse> => {
      const key = process.env.GEMINI_API_KEY;
      if (!key) throw new Error("GEMINI_API_KEY ausente");
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
      if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
      const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      return {
        id: "p1", provider: "gemini", model: "gemini-2.5-flash",
        content: data.candidates?.[0]?.content?.parts?.[0]?.text ?? "RESPOSTA",
        usage: { prompt_tokens: 50, completion_tokens: 80, total_tokens: 130 },
        cached: false,
      };
    },
    stream: async function* () { yield { delta: "", done: true }; },
  };
}

async function main(): Promise<void> {
  setDriverForTest(null); // garante driver real no disco
  runMigrations();
  const db = getDriver();
  // Limpa a sessão anterior
  db.exec(`
    DELETE FROM curiosity_signals WHERE session_id='${SESSION}';
    DELETE FROM goals WHERE session_id='${SESSION}';
    DELETE FROM skills WHERE session_id='${SESSION}';
    DELETE FROM strategy_scores WHERE session_id='${SESSION}';
    DELETE FROM metabolism_snapshots WHERE session_id='${SESSION}';
    DELETE FROM reflections WHERE session_id='${SESSION}';
  `);

  const providers = new Map<string, ProviderAdapter>([["gemini", makeGeminiAdapter()]]);
  const task = "Em modo autônomo, crie uma função TypeScript que retorna o fatorial de um número";

  const report = await executeTask(task, providers, {
    sessionId: SESSION,
    persistAutonomousMemory: true,
  });

  // Conta o que foi gravado nesta sessão
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE session_id=?`).get(SESSION) as { n: number }).n;
  console.log(`[P1] stopReason=${report.autonomous?.stopReason}`);
  console.log(`[P1] persistido → skills=${count("skills")} strategy=${count("strategy_scores")} curiosity=${count("curiosity_signals")} goals=${count("goals")} metabolism=${count("metabolism_snapshots")} reflections=${count("reflections")}`);
  console.log(`[P1] session=${SESSION}`);

  // FIM DO PROCESSO 1 — o driver de memória não é mais usado; a partir daqui
  // qualquer novo processo lê do arquivo SQLite no disco (~/.axon/autonomous.db).
}

main().catch((e) => { console.error("[P1] ERRO:", e); process.exit(1); });