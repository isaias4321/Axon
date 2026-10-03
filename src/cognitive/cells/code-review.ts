/**
 * Fase 9 — CodeReviewCell.
 *
 * Célula responsável por revisar código.
 * Avalia: correctness, security, performance, simplificação.
 * Produz findings estruturados com severity e categoria.
 */

import type {
  CellInput,
  CellOutput,
  CellExecutionContext,
  CellCapability,
  CellType,
  CellId,
} from "../types.js";
import { BaseCognitiveCell } from "../cell.js";

export interface CodeReviewInput extends CellInput {
  type: "code_review";
  payload: {
    files?: string[];
    patterns?: string[];
    lenses?: Array<"correctness" | "security" | "performance" | "simplification">;
    severity?: "all" | "high" | "medium" | "low";
    task?: string;
  };
}

export interface ReviewFinding {
  file: string;
  line?: number;
  severity: "high" | "medium" | "low";
  category: "correctness" | "security" | "performance" | "simplification" | "style";
  title: string;
  description: string;
  suggestedFix?: string;
  evidence?: string;
  confidence: number;
}

export interface ReviewSummary {
  totalFindings: number;
  bySeverity: Record<string, number>;
  byCategory: Record<string, number>;
  topFindings: ReviewFinding[];
}

export interface CodeReviewOutput {
  filesAnalyzed: string[];
  findings: ReviewFinding[];
  summary: ReviewSummary;
  recommendations: string[];
}

export class CodeReviewCell extends BaseCognitiveCell<CodeReviewInput, CodeReviewOutput> {
  public readonly id: CellId = "code-review-cell-1";
  public readonly type: CellType = "code_review";
  public readonly name = "CodeReviewCell";
  public readonly capabilities: CellCapability[] = [
    "code_review_correctness",
    "code_review_security",
    "code_review_performance",
    "code_review_simplification",
  ];
  public readonly description = "Revisa código com foco em correctness, security, performance e simplificação, produzindo findings estruturados";

  protected async executeImpl(input: CodeReviewInput, context: CellExecutionContext): Promise<CodeReviewOutput> {
    const {
      files = [],
      patterns = [],
      lenses = ["correctness", "security", "performance", "simplification"],
      severity = "all",
      task,
    } = input.payload;

    this.recordTokens(200);

    // 1. Descobrir arquivos a revisar
    const filesToReview = await this.discoverFiles(files, patterns, context);

    // 2. Revisar cada arquivo com cada lens
    const findings: ReviewFinding[] = [];
    for (const file of filesToReview) {
      for (const lens of lenses) {
        const lensFindings = await this.reviewWithLens(file, lens, context);
        findings.push(...lensFindings);
      }
    }

    // 3. Filtrar por severidade
    const filtered = severity === "all" ? findings : findings.filter(f => f.severity === severity);

    // 4. Deduplicar por file+line+category
    const uniqueFindings = this.deduplicateFindings(filtered);

    // 5. Gerar summary
    const summary = this.generateSummary(uniqueFindings);

    // 6. Gerar recomendações
    const recommendations = this.generateRecommendations(uniqueFindings, filesToReview);

    this.recordTokens(500);

    return {
      filesAnalyzed: filesToReview,
      findings: uniqueFindings,
      summary,
      recommendations,
    };
  }

  /**
   * Descobre arquivos a revisar.
   */
  private async discoverFiles(files: string[], patterns: string[], context: CellExecutionContext): Promise<string[]> {
    const discovered: string[] = [];

    // Arquivos explicitamente fornecidos
    discovered.push(...files.filter(f => f.endsWith(".ts") || f.endsWith(".js") || f.endsWith(".json")));

    // Arquivos via patterns
    if (patterns.length > 0) {
      // Em produção, usaria filesystem tool com glob
      // Simulação com arquivos conhecidos do projeto
      const knownFiles = [
        "src/adaptive/autonomous.ts",
        "src/adaptive/planner.ts",
        "src/adaptive/executor.ts",
        "src/adaptive/decision.ts",
        "src/adaptive/validator.ts",
        "src/adaptive/modelRouter.ts",
        "src/adaptive/runtime.ts",
        "src/routes/chat.ts",
        "src/routes/run.ts",
        "src/lib/rateLimiter.ts",
        "src/lib/cache.ts",
        "src/lib/retry.ts",
        "src/providers/registry.ts",
      ];

      for (const pattern of patterns) {
        const regex = new RegExp(pattern.replace(/\*/g, ".*").replace(/\?/g, "."));
        discovered.push(...knownFiles.filter(f => regex.test(f)));
      }
    }

    // Deduplicar
    return [...new Set(discovered)];
  }

  /**
   * Revisa um arquivo com uma lens específica.
   */
  private async reviewWithLens(
    file: string,
    lens: "correctness" | "security" | "performance" | "simplification",
    context: CellExecutionContext
  ): Promise<ReviewFinding[]> {
    // Em produção, leria o conteúdo real do arquivo via filesystem tool
    // Simulação: analisar baseado no tipo de arquivo e conhecimento do projeto

    const findings: ReviewFinding[] = [];
    const fileContent = await this.readFileForReview(file, context);

    if (!fileContent) return findings;

    switch (lens) {
      case "correctness":
        findings.push(...this.reviewCorrectness(file, fileContent));
        break;
      case "security":
        findings.push(...this.reviewSecurity(file, fileContent));
        break;
      case "performance":
        findings.push(...this.reviewPerformance(file, fileContent));
        break;
      case "simplification":
        findings.push(...this.reviewSimplification(file, fileContent));
        break;
    }

    return findings;
  }

  /**
   * Revisa correctness.
   */
  private reviewCorrectness(file: string, content: string): ReviewFinding[] {
    const findings: ReviewFinding[] = [];

    // Padrões de correctness conhecidos
    const patterns: Array<{ regex: RegExp; severity: ReviewFinding["severity"]; title: string; description: string; fix?: string; suggestedFix?: string }> = [
      {
        regex: /catch\s*\([^)]*\)\s*\{\s*\}/,
        severity: "medium",
        title: "Catch vazio ignorando erro",
        description: "Catch sem tratamento pode mascarar erros reais",
        suggestedFix: "Adicionar logging ou tratamento mínimo no catch",
      },
      {
        regex: /Date\.now\(\)\s*===\s*/,
        severity: "high",
        title: "Comparação de timestamps exata",
        description: "Comparação exata de Date.now() é propensa a falhas por timing",
        suggestedFix: "Usar comparação de intervalo (>= e <=)",
      },
      {
        regex: /as\s+unknown\s+as/,
        severity: "medium",
        title: "Double cast inseguro",
        description: "Double cast (as unknown as) indica má tipagem",
        suggestedFix: "Revisar tipagem e usar type guards",
      },
      {
        regex: /console\.log\(/,
        severity: "low",
        title: "Console.log em produção",
        description: "Logs de debug podem vazar em produção",
        suggestedFix: "Usar logger estruturado (pino)",
      },
    ];

    for (const pattern of patterns) {
      if (pattern.regex.test(content)) {
        findings.push({
          file,
          severity: pattern.severity,
          category: "correctness",
          title: pattern.title,
          description: pattern.description,
          suggestedFix: pattern.fix ?? pattern.suggestedFix,
          confidence: 0.75,
        });
      }
    }

    return findings;
  }

  /**
   * Revisa segurança.
   */
  private reviewSecurity(file: string, content: string): ReviewFinding[] {
    const findings: ReviewFinding[] = [];

    // Padrões de segurança conhecidos
    const patterns: Array<{ regex: RegExp; severity: ReviewFinding["severity"]; title: string; description: string; fix?: string; suggestedFix?: string }> = [
      {
        regex: /process\.env\.[A-Z_]+/,
        severity: "medium",
        title: "Variável de ambiente usada diretamente",
        description: "Acesso direto a env vars sem validação pode expor config inválida",
        fix: "Centralizar acesso via config.ts com validação Zod",
      },
      {
        regex: /(password|secret|api[_-]?key|token)\s*=\s*["'][^"']+["']/i,
        severity: "high",
        title: "Segredo hardcoded no código",
        description: "Credenciais hardcoded são risco de vazamento",
        suggestedFix: "Mover para variáveis de ambiente (com validação)",
      },
      {
        regex: /eval\(/,
        severity: "high",
        title: "Uso de eval()",
        description: "eval() é vetor de injeção de código",
        suggestedFix: "Evitar eval, usar alternativas seguras",
      },
      {
        regex: /exec\(|spawn\(/,
        severity: "high",
        title: "Execução de comandos shell",
        description: "Comandos shell podem permitir command injection",
        suggestedFix: "Sanitizar inputs e validar argumentos",
      },
    ];

    for (const pattern of patterns) {
      if (pattern.regex.test(content)) {
        findings.push({
          file,
          severity: pattern.severity,
          category: "security",
          title: pattern.title,
          description: pattern.description,
          suggestedFix: pattern.fix ?? pattern.suggestedFix,
          confidence: 0.8,
        });
      }
    }

    // Verificar autorização (provedor, auth)
    if (file.includes("auth") || file.includes("route")) {
      const hasAuthCheck = content.includes("x-api-key") || content.includes("validKeys") || content.includes("unauthorized");
      if (!hasAuthCheck) {
        findings.push({
          file,
          severity: "high",
          category: "security",
          title: "Falta verificação de autorização",
          description: "Rota/arquivo sensível sem verificação de auth explícita",
          suggestedFix: "Adicionar validação de chave de API antes de processar requisição",
          confidence: 0.7,
        });
      }
    }

    return findings;
  }

  /**
   * Revisa performance.
   */
  private reviewPerformance(file: string, content: string): ReviewFinding[] {
    const findings: ReviewFinding[] = [];

    // Padrões de performance conhecidos
    const patterns: Array<{ regex: RegExp; severity: ReviewFinding["severity"]; title: string; description: string; fix?: string; suggestedFix?: string }> = [
      {
        regex: /\.map\([^)]*\)\.map\(/,
        severity: "medium",
        title: "Encadeamento de map()",
        description: "Múltiplos map() em sequência criam arrays intermediários",
        suggestedFix: "Combinar em um único map ou usar flatMap",
      },
      {
        regex: /await\s+for\s*\(/i,
        severity: "medium",
        title: "Loop com await sequencial",
        description: "Await em loop executa operações em série",
        suggestedFix: "Usar Promise.all para operações independentes",
      },
      {
        regex: /JSON\.parse\([^)]*\.content_json/,
        severity: "low",
        title: "JSON.parse repetido",
        description: "Parsing repetido do mesmo JSON pode ser cacheado",
        suggestedFix: "Cachear resultado do parse",
      },
      {
        regex: /new Map\(\)/,
        severity: "low",
        title: "Map criado em cada execução",
        description: "Map criado dentro de função executada frequentemente",
        suggestedFix: "Mover para escopo de módulo se imutável",
      },
    ];

    for (const pattern of patterns) {
      if (pattern.regex.test(content)) {
        findings.push({
          file,
          severity: pattern.severity,
          category: "performance",
          title: pattern.title,
          description: pattern.description,
          suggestedFix: pattern.fix ?? pattern.suggestedFix,
          confidence: 0.65,
        });
      }
    }

    // Verificar patterns de rate limiting/cache (arquivos de lib)
    if (file.includes("lib") || file.includes("route")) {
      const hasRateLimit = content.includes("rateLimiter") || content.includes("tryConsume");
      if (!hasRateLimit && file.includes("route")) {
        findings.push({
          file,
          severity: "low",
          category: "performance",
          title: "Sem rate limiting",
          description: "Rota sem proteção de rate limiting pode ser abusada",
          suggestedFix: "Adicionar rate limiting via TokenBucketRateLimiter",
          confidence: 0.6,
        });
      }
    }

    return findings;
  }

  /**
   * Revisa simplificação.
   */
  private reviewSimplification(file: string, content: string): ReviewFinding[] {
    const findings: ReviewFinding[] = [];

    // Padrões de simplificação conhecidos
    const patterns: Array<{ regex: RegExp; severity: ReviewFinding["severity"]; title: string; description: string; fix?: string; suggestedFix?: string }> = [
      {
        regex: /if\s*\([^)]+\)\s*\{\s*return\s+true;\s*\}\s*else\s*\{\s*return\s+false;\s*\}/,
        severity: "low",
        title: "If-else desnecessário",
        description: "Retorno booleano com if-else pode ser simplificado",
        suggestedFix: "Retornar a expressão booleana diretamente",
      },
      {
        regex: /(?:const|let)\s+\w+\s*=\s*[^;]+;\s*\n\s*\w+\s*\(/,
        severity: "low",
        title: "Variável intermediária desnecessária",
        description: "Variável usada apenas uma vez pode ser inline",
        suggestedFix: "Inline da variável na chamada",
      },
      {
        regex: /function\s+(\w+)[^}]{0,500}}/,
        severity: "low",
        title: "Função longa",
        description: "Função com lógica extensa pode ser decomposta",
        suggestedFix: "Extrair sub-funções para melhorar legibilidade",
      },
    ];

    for (const pattern of patterns) {
      if (pattern.regex.test(content)) {
        findings.push({
          file,
          severity: pattern.severity,
          category: "simplification",
          title: pattern.title,
          description: pattern.description,
          suggestedFix: pattern.fix ?? pattern.suggestedFix,
          confidence: 0.6,
        });
      }
    }

    return findings;
  }

  /**
   * Lê conteúdo do arquivo para revisão.
   */
  private async readFileForReview(file: string, context: CellExecutionContext): Promise<string | null> {
    // Em produção, usaria filesystem tool
    // Simulação com conteúdo conhecido
    const simulatedContent: Record<string, string> = {
      "src/lib/rateLimiter.ts": `export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  constructor(private readonly maxTokens: number, private readonly refillWindowMs: number) {}
  tryConsume(key: string): RateLimitResult {
    const now = Date.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.maxTokens, lastRefillAt: now };
    const elapsed = now - bucket.lastRefillAt;
    const refillRate = this.maxTokens / this.refillWindowMs;
    const refilled = Math.min(this.maxTokens, bucket.tokens + elapsed * refillRate);
    if (refilled < 1) { return { allowed: false, retryAfterMs: Math.ceil((1 - refilled) / refillRate), remaining: 0 }; }
    const remaining = refilled - 1;
    this.buckets.set(key, { tokens: remaining, lastRefillAt: now });
    return { allowed: true, retryAfterMs: 0, remaining: Math.floor(remaining) };
  }
  reset(key: string): void { this.buckets.delete(key); }
}`,
      "src/routes/chat.ts": `const limitResult = await rateLimiter.tryConsume(request.apiKey);
reply.header("x-ratelimit-remaining", limitResult.remaining);
if (!limitResult.allowed) {
  reply.header("retry-after", Math.ceil(limitResult.retryAfterMs / 1000));
  return reply.code(429).send({ error: "rate_limited", message: "Limite de requisições excedido." });
}`,
      "src/adaptive/autonomous.ts": `async function runAutonomous(...) {
  // Loop principal
  while (true) {
    const budgetCheck = budgetManager.check();
    if (budgetCheck.exceeded) { stopReason = budgetCheck.reason ?? "failure"; break; }
    iteration += 1;
    const currentStep = selectNextStep(currentPlan);
    if (!currentStep) { stopReason = "success"; break; }
    const execResult = await executeOneStep(currentStep, task, profile, { runner, toolRegistry: registry, providers, catalog });
    const validation = await validateStep(task, currentStep.description, execResult.observation, currentStep.capability, { enableCritic: true });
    const decision_ = decideNextAction({ step: currentStep, observation: execResult.observation, validation, plan: currentPlan, profile, consecutiveFailures });
    // Processar decisão
  }
}`,
      "src/lib/retry.ts": `export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { maxAttempts = 3, baseDelayMs = 300, maxDelayMs = 5000, shouldRetry = defaultShouldRetry } = options;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try { return await fn(); } catch (error) {
      lastError = error;
      if (attempt === maxAttempts || !shouldRetry(error, attempt)) throw error;
      const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jitter = Math.random() * exponential * 0.3;
      await sleep(exponential + jitter);
    }
  }
  throw lastError;
}`,
    };

    return simulatedContent[file] || null;
  }

  /**
   * Deduplica findings por file+line+category.
   */
  private deduplicateFindings(findings: ReviewFinding[]): ReviewFinding[] {
    const seen = new Map<string, ReviewFinding>();

    for (const f of findings) {
      const key = `${f.file}:${f.line || 0}:${f.category}:${f.title}`;
      const existing = seen.get(key);

      if (!existing || (f.severity === "high" && existing.severity !== "high")) {
        seen.set(key, f);
      }
    }

    return Array.from(seen.values());
  }

  /**
   * Gera summary dos findings.
   */
  private generateSummary(findings: ReviewFinding[]): ReviewSummary {
    const bySeverity: Record<string, number> = { high: 0, medium: 0, low: 0 };
    const byCategory: Record<string, number> = {};

    for (const f of findings) {
      bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
      byCategory[f.category] = (byCategory[f.category] || 0) + 1;
    }

    // Ordenar por severidade (high primeiro)
    const topFindings = [...findings].sort((a, b) => {
      const severityOrder = { high: 0, medium: 1, low: 2 };
      return (severityOrder[a.severity] || 3) - (severityOrder[b.severity] || 3);
    });

    return {
      totalFindings: findings.length,
      bySeverity,
      byCategory,
      topFindings: topFindings.slice(0, 5),
    };
  }

  /**
   * Gera recomendações.
   */
  private generateRecommendations(findings: ReviewFinding[], files: string[]): string[] {
    const recs: string[] = [];

    if (findings.length === 0) {
      return ["Nenhum finding crítico encontrado. O código parece saudável."];
    }

    const highCount = findings.filter(f => f.severity === "high").length;
    if (highCount > 0) {
      recs.push(`Corrigir os ${highCount} findings de severidade HIGH primeiro`);
    }

    const byCategory = this.generateSummary(findings).byCategory;
    for (const [cat, count] of Object.entries(byCategory)) {
      if (count > 0) {
        recs.push(`Revisar ${count} finding(s) de ${cat}`);
      }
    }

    recs.push(`Arquivos revisados: ${files.length}`);
    recs.push("Executar testes após aplicar correções");

    return recs;
  }
}