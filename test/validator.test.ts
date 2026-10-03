import { describe, expect, it, vi } from "vitest";
import { validateStep } from "../src/adaptive/validator.js";
import { analyzeTask } from "../src/adaptive/taskAnalyzer.js";
import type { ProviderAdapter } from "../src/providers/types.js";
import type { ChatCompletionResponse } from "../src/schemas/chat.js";
import type { Observation } from "../src/adaptive/types.js";

function fakeAdapter(provider: string): ProviderAdapter {
  return { name: provider as ProviderAdapter["name"], complete: vi.fn(), stream: vi.fn() };
}

function buildProviders(...names: string[]): Map<string, ProviderAdapter> {
  return new Map(names.map((name) => [name, fakeAdapter(name)]));
}

function fakeRunner(content: string) {
  return {
    complete: vi.fn().mockResolvedValue({
      id: "resp",
      provider: "gemini",
      model: "gemini-2.5-flash",
      content,
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      cached: false,
    } satisfies ChatCompletionResponse),
  };
}

const TASK = "Em modo autonomo, implemente uma função";

function makeObservation(output: string | null, error: string | null = null): Observation {
  return {
    success: error === null && output !== null,
    output,
    error,
    exitCode: error === null ? 0 : 1,
    durationMs: 100,
    toolName: "llm:gemini",
    metadata: {},
  };
}

describe("Validator", () => {
  it("validação heurística passa para código com sintaxe", async () => {
    const profile = analyzeTask(TASK);
    const obs = makeObservation("```ts\nconst x = 1;\n```");

    const result = await validateStep(TASK, "Implementar", obs, "geracao_codigo", {
      enableCritic: false,
      profile,
      providers: buildProviders("gemini"),
    });

    expect(result.passed).toBe(true);
    expect(result.validatorType).toBe("heuristic");
  });

  it("REGRESSÃO — resposta truncada por limite de tokens (finish_reason=length) falha mesmo parecendo código válido", async () => {
    // Bug real: max_tokens estava hardcoded em 1024 pra QUALQUER etapa,
    // cortando geração de código multi-arquivo no meio de uma função — e o
    // finish_reason da API (que diria exatamente isso) nunca era lido em
    // lugar nenhum, então a resposta cortada passava como sucesso completo.
    const profile = analyzeTask(TASK);
    // Conteúdo que PARECE válido (tem bloco de código, palavras-chave) mas
    // está com metadata.finishReason="length" — deve falhar mesmo assim.
    const obs: Observation = {
      success: true,
      output: "```python\ndef somar(a, b):\n    return a + b\n\ndef logarit",
      error: null,
      exitCode: 0,
      durationMs: 100,
      toolName: "llm:gemini",
      metadata: { finishReason: "length" },
    };

    const result = await validateStep(TASK, "Gerar o código", obs, "geracao_codigo", {
      enableCritic: false,
      profile,
      providers: buildProviders("gemini"),
    });

    expect(result.passed).toBe(false);
    expect(result.issues.join(" ")).toMatch(/truncad/i);
  });

  it("validação heurística falha para código sem sintaxe", async () => {
    const profile = analyzeTask(TASK);
    const obs = makeObservation("Apenas texto sem código");

    const result = await validateStep(TASK, "Implementar", obs, "geracao_codigo", {
      enableCritic: false,
      profile,
      providers: buildProviders("gemini"),
    });

    expect(result.passed).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("validação falha para saída vazia", async () => {
    const profile = analyzeTask(TASK);
    const obs = makeObservation(null);

    const result = await validateStep(TASK, "Analisar", obs, "analise", {
      enableCritic: false,
      profile,
      providers: buildProviders("gemini"),
    });

    expect(result.passed).toBe(false);
  });

  it("Critic LLM é chamado para complexidade alta e heurística passou", async () => {
    const profile = analyzeTask("Em modo autonomo, analise e implemente arquitetura complexa de microservicos");
    const obs = makeObservation("```ts\nconst x = 1;\n```");
    const runner = fakeRunner(JSON.stringify({
      passed: true,
      confidence: 0.9,
      issues: [],
      suggestedCorrection: null,
    }));

    const result = await validateStep(TASK, "Implementar", obs, "geracao_codigo", {
      enableCritic: true,
      criticModel: "gemini-2.5-flash",
      profile,
      runner,
      providers: buildProviders("gemini"),
    });

    expect(result.validatorType).toBe("critic_llm");
    expect(result.passed).toBe(true);
    expect(result.confidence).toBeCloseTo(0.9);
  });

  it("Critic fallback para heurística quando LLM falha", async () => {
    const profile = analyzeTask("Em modo autonomo, analise e implemente arquitetura complexa");
    const obs = makeObservation("```ts\nconst x = 1;\n```");
    const runner = {
      complete: vi.fn().mockRejectedValue(new Error("critic down")),
    };

    const result = await validateStep(TASK, "Implementar", obs, "geracao_codigo", {
      enableCritic: true,
      criticModel: "gemini-2.5-flash",
      profile,
      runner,
      providers: buildProviders("gemini"),
    });

    // Mesmo com critic falhando, a heurística passou → resultado passa
    expect(result.passed).toBe(true);
    expect(result.validatorType).toBe("critic_llm");
  });

  it("Critic não é chamado para complexidade baixa (mesmo enableCritic=true)", async () => {
    const profile = analyzeTask("Olá, tudo bem?");
    const obs = makeObservation("Oi! Tudo bem, obrigado!");
    const runner = fakeRunner("should not be called");

    const result = await validateStep(TASK, "Conversar", obs, "conversa", {
      enableCritic: true,
      criticModel: "gemini-2.5-flash",
      profile,
      runner,
      providers: buildProviders("gemini"),
    });

    expect(result.validatorType).toBe("heuristic");
    expect(runner.complete).not.toHaveBeenCalled();
  });

  it("Critic NÃO é chamado para execução real de ferramenta (mesmo em complexidade alta) — bug reportado", async () => {
    // Reproduz o cenário real reportado: uma etapa de execucao_ferramenta
    // (ex.: filesystem.read) executou com sucesso real, mas antes desta
    // correção o Critic LLM ainda era chamado (porque a condição só olhava
    // heuristic.passed + complexity, nunca observation.toolName) e podia
    // reprovar um resultado que já era, de fato, um sucesso real — travando
    // o loop em correções inúteis do mesmo passo até max_iterations.
    const profile = analyzeTask(
      "Crie um arquivo chamado axon-test.txt contendo exatamente Hello from Axon. Depois leia o arquivo que você acabou de criar, confirme que o conteúdo está correto e valide a execução."
    );
    expect(profile.complexity).toBe("alta"); // pré-condição do bug: só ocorre em complexidade alta

    const obs: Observation = {
      success: true,
      output: "export function models() { /* ...conteúdo real do arquivo lido... */ }",
      error: null,
      exitCode: 0,
      durationMs: 42,
      toolName: "filesystem",
      metadata: { action: "read" },
    };

    // Critic configurado para REJEITAR — se ele for chamado, o teste falha
    // com validatorType "critic_llm" e passed=false, provando a regressão.
    const runner = {
      complete: vi.fn().mockResolvedValue({
        id: "resp-critic",
        provider: "gemini",
        model: "gemini-2.5-flash",
        content: JSON.stringify({
          passed: false,
          confidence: 0.9,
          issues: ["não confirma explicitamente as alterações"],
          suggestedCorrection: null,
        }),
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        cached: false,
      } satisfies ChatCompletionResponse),
    };

    const result = await validateStep(
      "tarefa",
      "Ler o conteúdo atualizado de src/routes/models.ts para confirmar as alterações",
      obs,
      "execucao_ferramenta",
      {
        enableCritic: true,
        criticModel: "gemini-2.5-flash",
        profile,
        runner,
        providers: buildProviders("gemini"),
      }
    );

    expect(result.passed).toBe(true);
    expect(result.validatorType).toBe("heuristic");
    expect(runner.complete).not.toHaveBeenCalled();
  });

  it("aprova geração de código que é só JSDoc (sem ``` nem palavras-chave de linguagem) — bug reportado", async () => {
    // Reproduz o cenário real: pedir para adicionar comentários JSDoc a
    // funções existentes. A resposta do modelo é só o bloco de comentário
    // — não contém "function/const/class/return" (a função já existe, o
    // modelo só adiciona o comentário acima dela) nem necessariamente vem
    // cercada por ```. Antes desta correção, isso reprovava por engano.
    const obs = makeObservation(
      "/**\n * Retorna a lista de modelos disponíveis.\n * @param {Request} req - Requisição HTTP.\n * @returns {Promise<Model[]>} Lista de modelos.\n */"
    );
    const result = await validateStep(TASK, "Gerar o código JSDoc", obs, "geracao_codigo", {
      enableCritic: false,
      profile: analyzeTask(TASK),
      providers: buildProviders("gemini"),
    });

    expect(result.passed).toBe(true);
  });

  it("aprova JSDoc curto sem @param/@returns/```/palavras-chave — reprovou 3x seguidas em uso real", async () => {
    // Segunda reincidência do mesmo bug de fundo: a correção anterior só
    // cobria JSDoc com tags @param/@returns/@type/@description. Uma função
    // sem parâmetros relevantes a documentar (ex.: um getter simples) gera
    // um JSDoc só com descrição, sem nenhuma tag — que ainda reprovava.
    const obs = makeObservation(
      "/**\n * Retorna a lista de modelos suportados pela API.\n */"
    );
    const result = await validateStep(TASK, "Gerar o código dos comentários JSDoc", obs, "geracao_codigo", {
      enableCritic: false,
      profile: analyzeTask(TASK),
      providers: buildProviders("gemini"),
    });

    expect(result.passed).toBe(true);
  });

  it("aprova explicação de código em prosa substancial, mesmo sem nenhuma sintaxe de código", async () => {
    // Rede de segurança final: mesmo sem code fence, palavra-chave de
    // linguagem OU comentário de bloco, uma resposta com desenvolvimento
    // real (não uma recusa vazia) não deveria travar o loop à toa.
    const obs = makeObservation(
      "Adicionei uma linha de documentação acima de cada função pública explicando seu propósito, parâmetros esperados e o valor retornado, seguindo o padrão já usado no restante do arquivo."
    );
    const result = await validateStep(TASK, "Gerar o código", obs, "geracao_codigo", {
      enableCritic: false,
      profile: analyzeTask(TASK),
      providers: buildProviders("gemini"),
    });

    expect(result.passed).toBe(true);
  });

  it("continua reprovando geração de código vazia/recusa", async () => {
    const obs = makeObservation("Não posso gerar esse código.");
    const result = await validateStep(TASK, "Gerar o código", obs, "geracao_codigo", {
      enableCritic: false,
      profile: analyzeTask(TASK),
      providers: buildProviders("gemini"),
    });

    expect(result.passed).toBe(false);
  });

  it("aprova plano bem estruturado sem as palavras-chave literais antigas — bug reportado", async () => {
    // Reproduz o cenário real: um plano genuinamente sequencial, mas que
    // não usa nenhuma das palavras exatas "etapa/passo/fase/plano" nem o
    // formato "1." — usa "1)" e conectivos ("Em seguida", "Depois").
    // Antes desta correção, isso reprovava só por não bater no regex
    // literal, mesmo sendo um plano perfeitamente válido.
    const obs = makeObservation(
      "1) Localizar as funções públicas exportadas no arquivo.\n" +
        "Em seguida, inserir o bloco de comentário JSDoc imediatamente acima de cada uma.\n" +
        "Depois, confirmar que a sintaxe do comentário está correta."
    );
    const result = await validateStep(TASK, "Planejar a adição dos comentários", obs, "planejamento", {
      enableCritic: false,
      profile: analyzeTask(TASK),
      providers: buildProviders("gemini"),
    });

    expect(result.passed).toBe(true);
  });

  it("ainda reprova planejamento vazio/sem desenvolvimento nenhum", async () => {
    const obs = makeObservation("Ok, vou planejar.");
    const result = await validateStep(TASK, "Planejar", obs, "planejamento", {
      enableCritic: false,
      profile: analyzeTask(TASK),
      providers: buildProviders("gemini"),
    });

    expect(result.passed).toBe(false);
  });
});
