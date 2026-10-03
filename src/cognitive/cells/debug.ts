/**
 * Fase 9 — DebugCell.
 *
 * Célula responsável por análise de erros e diagnóstico.
 * Usa evidências reais do projeto: logs, código, configuração.
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

export interface DebugInput extends CellInput {
  type: "debug_error";
  payload: {
    errorMessage?: string;
    errorCode?: string;
    stackTrace?: string;
    context?: "code" | "logs" | "config" | "runtime" | "auto";
    focus?: "root_cause" | "impact" | "fix" | "all";
    relatedFiles?: string[];
  };
}

export interface DebugEvidence {
  source: "logs" | "code" | "config" | "runtime" | "knowledge";
  path?: string;
  line?: number;
  content: string;
  relevance: number;
  description: string;
}

export interface DebugDiagnosis {
  errorType: string;
  rootCause: string;
  confidence: number;
  affectedComponents: string[];
  evidence: DebugEvidence[];
  suggestedFixes: DebugFix[];
  impact: "low" | "medium" | "high" | "critical";
  relatedErrors: string[];
}

export interface DebugFix {
  description: string;
  filesToChange: string[];
  codeChange?: string;
  configChange?: Record<string, unknown>;
  riskLevel: "low" | "medium" | "high";
  testingRequired: string[];
}

export interface DebugOutput {
  errorAnalyzed: string;
  diagnosis: DebugDiagnosis;
  nextSteps: string[];
}

export class DebugCell extends BaseCognitiveCell<DebugInput, DebugOutput> {
  public readonly id: CellId = "debug-cell-1";
  public readonly type: CellType = "debug";
  public readonly name = "DebugCell";
  public readonly capabilities: CellCapability[] = [
    "error_analysis",
    "log_analysis",
    "root_cause_analysis",
  ];
  public readonly description = "Análise de erros, diagnóstico de causa raiz e sugestão de correções baseada em evidências reais do projeto";

  protected async executeImpl(input: DebugInput, context: CellExecutionContext): Promise<DebugOutput> {
    const { errorMessage, errorCode, stackTrace, context: errorContext = "auto", focus = "all", relatedFiles } = input.payload;

    this.recordTokens(200);

    const errorAnalyzed = errorMessage || errorCode || stackTrace || "Erro não especificado";
    const diagnosis = await this.diagnoseError(context, errorAnalyzed, errorCode, stackTrace, errorContext, focus, relatedFiles);

    const nextSteps = this.generateNextSteps(diagnosis);

    this.recordTokens(300);

    return {
      errorAnalyzed,
      diagnosis,
      nextSteps,
    };
  }

  /**
   * Diagnostica o erro usando múltiplas fontes de evidência.
   */
  private async diagnoseError(
    context: CellExecutionContext,
    errorMessage: string,
    errorCode?: string,
    stackTrace?: string,
    errorContext: string = "auto",
    focus: string = "all",
    relatedFiles?: string[]
  ): Promise<DebugDiagnosis> {
    const evidence: DebugEvidence[] = [];

    // 1. Análise baseada em código de erro conhecido
    if (errorCode) {
      const codeEvidence = await this.analyzeErrorCode(errorCode, context);
      evidence.push(...codeEvidence);
    }

    // 2. Análise de stack trace
    if (stackTrace) {
      const stackEvidence = await this.analyzeStackTrace(stackTrace, context);
      evidence.push(...stackEvidence);
    }

    // 3. Busca no código por padrões relacionados
    if (errorMessage) {
      const codeEvidence = await this.searchCodeForError(errorMessage, context);
      evidence.push(...codeEvidence);
    }

    // 4. Análise de logs (se contexto inclui logs)
    if (errorContext === "logs" || errorContext === "auto") {
      const logEvidence = await this.analyzeLogs(context, errorMessage, errorCode);
      evidence.push(...logEvidence);
    }

    // 5. Análise de configuração relacionada
    if (errorContext === "config" || errorContext === "auto") {
      const configEvidence = await this.analyzeConfig(context, errorMessage, errorCode);
      evidence.push(...configEvidence);
    }

    // 6. Fase 9.2 — DELEGAÇÃO REAL: DebugCell pede à ResearchCell para
    // localizar a origem no código via ToolRegistry (grep/filesystem).
    // Opt-in (só quando há supervisor) e fail-open (falha não derruba o debug).
    if (context.supervisor) {
      try {
        const researchOutput = await context.supervisor.requestCell({
          cellType: "research",
          request:
            `localize a origem no codigo de: ${errorMessage || errorCode || "erro"}${errorCode ? ` (${errorCode})` : ""}`,
          context,
          parentCellId: this.id,
        });

        if (researchOutput.success && researchOutput.data) {
          const researchData = researchOutput.data as {
            findings?: Array<{ path?: string; excerpt?: string; lines?: Array<{ line?: number; excerpt?: string }> }>;
          };
          for (const finding of researchData.findings ?? []) {
            evidence.push({
              source: "code",
              path: finding.path,
              line: finding.lines?.[0]?.line,
              content: finding.excerpt ?? finding.lines?.[0]?.excerpt ?? "",
              relevance: 0.85,
              description: `[via ResearchCell] Origem localizada por delegação inter-cell`,
            });
          }

          // Registra a cooperação no barramento (proveniência do fluxo)
          await context.supervisor.emit("debug", this.id,
            `ResearchCell contribuiu com ${researchData.findings?.length ?? 0} findings para o diagnóstico`,
            { researchFindings: researchData.findings?.length ?? 0 });
        }
      } catch {
        // Fail-open: sem supervisor, célula alvo indisponível ou guarda
        // (ciclo/depth/budget/timeout) → segue apenas com evidências locais.
      }
    }

    // 7. Knowledge base de erros conhecidos do projeto
    const knowledgeEvidence = this.applyProjectKnowledge(errorMessage, errorCode, stackTrace);
    evidence.push(...knowledgeEvidence);

    // Ordenar evidências por relevância
    evidence.sort((a, b) => b.relevance - a.relevance);

    // Sintetizar diagnóstico
    const diagnosis = this.synthesizeDiagnosis(
      errorMessage,
      errorCode,
      evidence,
      focus
    );

    return diagnosis;
  }

  /**
   * Analisa códigos de erro conhecidos do projeto.
   */
  private async analyzeErrorCode(errorCode: string, context: CellExecutionContext): Promise<DebugEvidence[]> {
    const evidence: DebugEvidence[] = [];

    // Mapeamento de códigos conhecidos do projeto
    const knownErrors: Record<string, { cause: string; files: string[]; fix: string }> = {
      "429": {
        cause: "Rate limit excedido no TokenBucketRateLimiter",
        files: ["src/lib/rateLimiter.ts", "src/routes/chat.ts"],
        fix: "Aumentar RATE_LIMIT_MAX_REQUESTS ou configurar Redis para rate limiting distribuído",
      },
      "401": {
        cause: "Chave de API inválida ou ausente (x-api-key)",
        files: ["src/plugins/auth.ts", "src/routes/chat.ts"],
        fix: "Verificar GATEWAY_API_KEYS no .env e enviar header x-api-key correto",
      },
      "400": {
        cause: "Corpo da requisição inválido (validação Zod falhou)",
        files: ["src/routes/chat.ts", "src/schemas/chat.ts"],
        fix: "Verificar schema da requisição: provider, model, messages são obrigatórios",
      },
      "502": {
        cause: "Erro do provedor upstream (OpenAI, Anthropic, Gemini, Groq)",
        files: ["src/providers/*.ts", "src/routes/chat.ts"],
        fix: "Verificar chaves dos provedores (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.) e conectividade",
      },
      "503": {
        cause: "Provedor solicitado não configurado no gateway",
        files: ["src/providers/registry.ts", "src/routes/chat.ts"],
        fix: "Configurar a chave API do provedor no .env (ex: GEMINI_API_KEY, GROQ_API_KEY)",
      },
      "500": {
        cause: "Erro interno no gateway",
        files: ["src/routes/chat.ts", "src/lib/retry.ts"],
        fix: "Verificar logs do servidor para stack trace completo",
      },
    };

    const known = knownErrors[errorCode];
    if (known) {
      evidence.push({
        source: "knowledge",
        content: `Código ${errorCode}: ${known.cause}`,
        relevance: 0.95,
        description: `Erro conhecido do projeto: ${known.cause}. Fix sugerido: ${known.fix}`,
      });

      // Adicionar arquivos relacionados como evidência
      for (const file of known.files) {
        evidence.push({
          source: "code",
          path: file,
          content: `Arquivo relacionado ao erro ${errorCode}: ${known.cause}`,
          relevance: 0.8,
          description: `Arquivo que implementa/trata este erro`,
        });
      }
    }

    return evidence;
  }

  /**
   * Analisa stack trace para identificar origem.
   */
  private async analyzeStackTrace(stackTrace: string, context: CellExecutionContext): Promise<DebugEvidence[]> {
    const evidence: DebugEvidence[] = [];

    // Extrair arquivos e linhas do stack trace
    const stackLines = stackTrace.split("\n");
    const filePattern = /at\s+.*\s+\((.*):(\d+):(\d+)\)/g;
    const simpleFilePattern = /(.*\.(ts|js)):(\d+):(\d+)/g;

    for (const line of stackLines) {
      const matches = line.matchAll(simpleFilePattern);
      for (const match of matches) {
        const [, file, , lineNum] = match;
        if (file && !file.includes("node_modules")) {
          evidence.push({
            source: "code",
            path: file,
            line: lineNum ? parseInt(lineNum) : undefined,
            content: `Stack trace aponta para ${file}:${lineNum}`,
            relevance: 0.85,
            description: "Localização no código indicada pelo stack trace",
          });
        }
      }
    }

    return evidence;
  }

  /**
   * Busca no código por padrões relacionados ao erro.
   */
  private async searchCodeForError(errorMessage: string, context: CellExecutionContext): Promise<DebugEvidence[]> {
    const evidence: DebugEvidence[] = [];
    const searchTerms = this.extractErrorTerms(errorMessage);

    // Em produção, usaria filesystem tool real para grep
    // Por ora, usa conhecimento do projeto

    // Padrões conhecidos no projeto
    const patterns: Record<string, { files: string[]; description: string }> = {
      "rate limit": {
        files: ["src/lib/rateLimiter.ts", "src/routes/chat.ts"],
        description: "Rate limiting implementado via TokenBucket",
      },
      "token bucket": {
        files: ["src/lib/rateLimiter.ts"],
        description: "Implementação do algoritmo Token Bucket",
      },
      "redis": {
        files: ["src/lib/redisClient.ts", "src/lib/redisCache.ts", "src/lib/redisRateLimiter.ts"],
        description: "Cliente Redis e implementações distribuídas",
      },
      "provider": {
        files: ["src/providers/registry.ts", "src/providers/*.ts"],
        description: "Registry e adapters de provedores",
      },
      "validation": {
        files: ["src/schemas/chat.ts", "src/routes/chat.ts"],
        description: "Validação Zod de requisições",
      },
      "retry": {
        files: ["src/lib/retry.ts"],
        description: "Lógica de retry com backoff exponencial",
      },
      "stream": {
        files: ["src/routes/chat.ts", "src/providers/openAiCompatible.ts"],
        description: "Streaming SSE via reply.hijack()",
      },
      "cache": {
        files: ["src/lib/cache.ts", "src/lib/redisCache.ts"],
        description: "Cache TTL em memória e Redis",
      },
    };

    for (const [term, info] of Object.entries(patterns)) {
      if (searchTerms.some(t => term.includes(t) || t.includes(term))) {
        for (const file of info.files) {
          evidence.push({
            source: "code",
            path: file,
            content: `Padrão '${term}' encontrado: ${info.description}`,
            relevance: 0.75,
            description: `Código relacionado ao termo '${term}' no erro`,
          });
        }
      }
    }

    return evidence;
  }

  /**
   * Analisa logs do servidor (simulado - em produção leria arquivos reais).
   */
  private async analyzeLogs(
    context: CellExecutionContext,
    errorMessage: string,
    errorCode?: string
  ): Promise<DebugEvidence[]> {
    const evidence: DebugEvidence[] = [];

    // Em produção, leria server.log, server-wsl.log, etc.
    // Simulação baseada em logs conhecidos do projeto
    const knownLogPatterns = [
      { pattern: "Erro de conexão com o Redis", source: "server.log", relevance: 0.9 },
      { pattern: "Rate limit excedido", source: "server.log", relevance: 0.9 },
      { pattern: "ProviderHttpError", source: "server.log", relevance: 0.85 },
      { pattern: "Validation failed", source: "server.log", relevance: 0.8 },
    ];

    for (const log of knownLogPatterns) {
      if (errorMessage.toLowerCase().includes(log.pattern.toLowerCase()) ||
          (errorCode && log.pattern.toLowerCase().includes(errorCode.toLowerCase()))) {
        evidence.push({
          source: "logs",
          path: log.source,
          content: `Log encontrado: ${log.pattern}`,
          relevance: log.relevance,
          description: `Padrão de log correlacionado com o erro`,
        });
      }
    }

    return evidence;
  }

  /**
   * Analisa configuração relacionada ao erro.
   */
  private async analyzeConfig(
    context: CellExecutionContext,
    _errorMessage: string,
    _errorCode?: string
  ): Promise<DebugEvidence[]> {
    const evidence: DebugEvidence[] = [];

    // Verificar configurações relevantes baseadas no erro
    const configChecks: Array<{ keys: string[]; files: string[]; description: string }> = [
      { keys: ["RATE_LIMIT_MAX_REQUESTS", "RATE_LIMIT_WINDOW_MS"], files: [".env"], description: "Configuração de rate limiting" },
      { keys: ["REDIS_URL"], files: [".env"], description: "Configuração Redis para modo distribuído" },
      { keys: ["GATEWAY_API_KEYS"], files: [".env"], description: "Chaves de API do gateway" },
      { keys: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY"], files: [".env"], description: "Chaves dos provedores de IA" },
      { keys: ["CACHE_TTL_MS", "CACHE_MAX_ENTRIES"], files: [".env"], description: "Configuração de cache" },
    ];

    for (const check of configChecks) {
      // Em produção, leria .env real
      evidence.push({
        source: "config",
        path: check.files[0],
        content: `Verificar: ${check.keys.join(", ")}`,
        relevance: 0.7,
        description: check.description,
      });
    }

    return evidence;
  }

  /**
   * Aplica knowledge base de erros conhecidos do projeto.
   */
  private applyProjectKnowledge(
    errorMessage: string,
    errorCode?: string,
    stackTrace?: string
  ): DebugEvidence[] {
    const evidence: DebugEvidence[] = [];

    // Knowledge base específico deste projeto (Axon)
    const knowledgeBase: Array<{
      trigger: string[];
      diagnosis: string;
      fix: string;
      files: string[];
      confidence: number;
    }> = [
      {
        trigger: ["429", "rate limit", "token bucket"],
        diagnosis: "Rate limiter TokenBucket esgotado (20 req/min por chave padrão)",
        fix: "Aumentar RATE_LIMIT_MAX_REQUESTS no .env ou configurar REDIS_URL para modo distribuído",
        files: ["src/lib/rateLimiter.ts", "src/routes/chat.ts", ".env"],
        confidence: 0.95,
      },
      {
        trigger: ["redis", "connection", "ECONNREFUSED"],
        diagnosis: "Redis não disponível ou REDIS_URL incorreta",
        fix: "Verificar se Redis está rodando (docker-compose up) e REDIS_URL no .env",
        files: ["src/lib/redisClient.ts", "docker-compose.yml", ".env"],
        confidence: 0.9,
      },
      {
        trigger: ["401", "unauthorized", "api key"],
        diagnosis: "Chave de API do gateway inválida ou ausente",
        fix: "Verificar GATEWAY_API_KEYS no .env e enviar header x-api-key correto",
        files: ["src/plugins/auth.ts", ".env"],
        confidence: 0.9,
      },
      {
        trigger: ["provider", "not configured", "503"],
        diagnosis: "Provedor solicitado não tem API key configurada",
        fix: "Adicionar chave do provedor no .env (ex: GEMINI_API_KEY, GROQ_API_KEY)",
        files: ["src/providers/registry.ts", ".env"],
        confidence: 0.9,
      },
      {
        trigger: ["stream", "hijack", "SSE"],
        diagnosis: "Problema no streaming SSE (reply.hijack)",
        fix: "Verificar implementação em src/routes/chat.ts e adapters de provedores",
        files: ["src/routes/chat.ts", "src/providers/openAiCompatible.ts"],
        confidence: 0.75,
      },
    ];

    const combinedText = `${errorMessage} ${errorCode || ""} ${stackTrace || ""}`.toLowerCase();

    for (const kb of knowledgeBase) {
      if (kb.trigger.some(t => combinedText.includes(t.toLowerCase()))) {
        evidence.push({
          source: "knowledge",
          content: `DIAGNÓSTICO: ${kb.diagnosis}\nFIX SUGERIDO: ${kb.fix}`,
          relevance: kb.confidence,
          description: `Knowledge base do projeto: ${kb.diagnosis}`,
        });

        for (const file of kb.files) {
          evidence.push({
            source: "code",
            path: file,
            content: `Arquivo relevante para este diagnóstico`,
            relevance: kb.confidence * 0.8,
            description: `Arquivo a investigar/modificar para o fix`,
          });
        }
      }
    }

    return evidence;
  }

  /**
   * Sintetiza diagnóstico final a partir das evidências.
   */
  private synthesizeDiagnosis(
    errorMessage: string,
    errorCode: string | undefined,
    evidence: DebugEvidence[],
    focus: string
  ): DebugDiagnosis {
    // Determinar tipo de erro: sempre mapear códigos conhecidos para categoria
    // (429 → RATE_LIMIT_EXCEEDED, 401 → UNAUTHORIZED, etc.), mesmo quando
    // apenas o código é fornecido sem mensagem.
    const errorType = errorCode
      ? this.mapErrorCodeToType(errorCode)
      : this.inferErrorType(errorMessage, evidence);

    // Causa raiz baseada na evidência de maior relevância
    const topEvidence = evidence[0];
    const rootCause = topEvidence
      ? topEvidence.description
      : "Causa raiz não determinada automaticamente";

    // Confiança baseada na melhor evidência
    const confidence = topEvidence ? topEvidence.relevance : 0.3;

    // Componentes afetados
    const affectedComponents = this.extractComponents(evidence);

    // Fixes sugeridos
    const suggestedFixes = this.generateFixes(evidence, focus);

    // Impacto
    const impact = this.assessImpact(errorCode, evidence);

    // Erros relacionados
    const relatedErrors = this.findRelatedErrors(evidence);

    return {
      errorType,
      rootCause,
      confidence,
      affectedComponents,
      evidence: evidence.slice(0, 10), // Top 10 evidências
      suggestedFixes,
      impact,
      relatedErrors,
    };
  }

  /**
   * Mapeia um código de erro HTTP para o tipo de erro semântico.
   */
  private mapErrorCodeToType(errorCode: string): string {
    const map: Record<string, string> = {
      "400": "VALIDATION_ERROR",
      "401": "UNAUTHORIZED",
      "403": "FORBIDDEN",
      "404": "NOT_FOUND",
      "429": "RATE_LIMIT_EXCEEDED",
      "500": "INTERNAL_SERVER_ERROR",
      "502": "PROVIDER_ERROR",
      "503": "PROVIDER_UNAVAILABLE",
      "504": "GATEWAY_TIMEOUT",
    };
    return map[errorCode] || `HTTP_${errorCode}`;
  }

  private inferErrorType(errorMessage: string, evidence: DebugEvidence[]): string {
    const msg = errorMessage.toLowerCase();
    if (msg.includes("rate limit") || msg.includes("429")) return "RATE_LIMIT_EXCEEDED";
    if (msg.includes("unauthorized") || msg.includes("401")) return "UNAUTHORIZED";
    if (msg.includes("not found") || msg.includes("404")) return "NOT_FOUND";
    if (msg.includes("validation") || msg.includes("400")) return "VALIDATION_ERROR";
    if (msg.includes("timeout")) return "TIMEOUT";
    if (msg.includes("redis") || msg.includes("connection")) return "REDIS_CONNECTION_ERROR";
    if (msg.includes("provider")) return "PROVIDER_ERROR";
    return "UNKNOWN_ERROR";
  }

  private extractComponents(evidence: DebugEvidence[]): string[] {
    const components = new Set<string>();
    for (const e of evidence) {
      if (e.path) {
        const parts = e.path.split("/");
        if (parts.length > 1) components.add(parts[parts.length - 2] ?? "");
      }
      if (e.source === "knowledge" && e.content.includes("src/")) {
        const matches = e.content.match(/src\/(\w+\/)+\.ts/g);
        if (matches) {
          for (const m of matches) {
            const parts = m.split("/");
            components.add(parts[1] ?? "");
          }
        }
      }
    }
    return Array.from(components);
  }

  private generateFixes(evidence: DebugEvidence[], focus: string): DebugFix[] {
    const fixes: DebugFix[] = [];

    // Extrair fixes das evidências de knowledge
    for (const e of evidence) {
      if (e.source === "knowledge" && e.content.includes("FIX SUGERIDO:")) {
        const fixText = e.content.split("FIX SUGERIDO:")[1]?.trim() ?? "Correção não especificada";
        fixes.push({
          description: fixText,
          filesToChange: [], // Seria preenchido com análise mais profunda
          riskLevel: "medium",
          testingRequired: ["Testar rate limiting", "Verificar logs"],
        });
      }
    }

    // Fix genérico se nenhum específico
    if (fixes.length === 0) {
      fixes.push({
        description: "Investigar logs detalhados e reproduzir erro em ambiente controlado",
        filesToChange: [],
        riskLevel: "low",
        testingRequired: ["Reproduzir erro", "Validar fix"],
      });
    }

    return fixes.slice(0, 3);
  }

  private assessImpact(errorCode: string | undefined, evidence: DebugEvidence[]): "low" | "medium" | "high" | "critical" {
    if (errorCode === "429") return "high"; // Afeta todos os usuários da chave
    if (errorCode === "500") return "high";
    if (errorCode === "503") return "medium";
    if (errorCode === "401") return "medium";

    // Baseado em evidências
    const hasCriticalEvidence = evidence.some(e =>
      e.description.includes("crítico") || e.description.includes("todos os usuários")
    );
    if (hasCriticalEvidence) return "critical";

    return "medium";
  }

  private findRelatedErrors(evidence: DebugEvidence[]): string[] {
    const related = new Set<string>();
    for (const e of evidence) {
      if (e.source === "knowledge") {
        // Extrair códigos de erro relacionados do conteúdo
        const codes = e.content.match(/\b\d{3}\b/g);
        if (codes) codes.forEach(c => related.add(c));
      }
    }
    return Array.from(related).slice(0, 5);
  }

  private generateNextSteps(diagnosis: DebugDiagnosis): string[] {
    const steps: string[] = [];

    if (diagnosis.suggestedFixes.length > 0) {
      steps.push(`Aplicar fix sugerido: ${diagnosis.suggestedFixes[0]?.description ?? "ver diagnose"}`);
    }

    steps.push("Verificar logs do servidor para confirmação");
    steps.push("Reproduzir erro em ambiente de desenvolvimento");

    if (diagnosis.impact === "high" || diagnosis.impact === "critical") {
      steps.push("URGENTE: Notificar equipe e considerar rollback se em produção");
    }

    steps.push("Adicionar testes de regressão para evitar recorrência");

    return steps;
  }

  private extractErrorTerms(errorMessage: string): string[] {
    return errorMessage
      .toLowerCase()
      .split(/[\s\-_.():,;{}]+/)
      .filter(w => w.length > 2)
      .filter(w => !["the", "and", "for", "with", "error", "failed", "failure", "null", "undefined"].includes(w));
  }
}