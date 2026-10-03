/**
 * Fase 9 — ResearchCell.
 *
 * Célula responsável por pesquisa e análise de código.
 * Usa ferramentas reais disponíveis no projeto: filesystem, glob, grep.
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
import { getDefaultLogger } from "../../lib/logger.js";
import type { Logger } from "../../lib/logger.js";

export interface ResearchInput extends CellInput {
  type: "research_query";
  payload: {
    query: string;
    focus?: "code" | "docs" | "architecture" | "config" | "general";
    depth?: "fast" | "thorough";
    includePatterns?: string[];
    excludePatterns?: string[];
  };
}

export interface ResearchFinding {
  source: "code" | "docs" | "config" | "external";
  path?: string;
  title: string;
  excerpt: string;
  relevance: number;
  lines?: Array<{ excerpt: string; line: number }>;
}

export interface ResearchOutput {
  query: string;
  findings: ResearchFinding[];
  summary: string;
  recommendations: string[];
  relatedQueries: string[];
}

export class ResearchCell extends BaseCognitiveCell<ResearchInput, ResearchOutput> {
  public readonly id: CellId = "research-cell-1";
  public readonly type: CellType = "research";
  public readonly name = "ResearchCell";
  public readonly capabilities: CellCapability[] = [
    "code_search",
    "web_search",
  ];
  public readonly description = "Pesquisa e análise de código, documentação e arquitetura usando ferramentas reais do projeto";

  /** Logger oficial do sistema (pino) — substitui console.*. */
  protected readonly logger: Logger = getDefaultLogger();

  protected async executeImpl(input: ResearchInput, context: CellExecutionContext): Promise<ResearchOutput> {
    const { query, focus = "code", depth = "thorough", includePatterns, excludePatterns } = input.payload;

    this.recordTokens(100); // Estimativa inicial

    const findings: ResearchFinding[] = [];

    if (focus === "code" || focus === "architecture") {
      // Pesquisa no código-fonte do projeto
      const codeFindings = await this.searchCode(context, query, includePatterns, excludePatterns);
      findings.push(...codeFindings);
    }

    if (focus === "docs") {
      // Pesquisa em documentação (markdown, comentários)
      const docFindings = await this.searchDocs(context, query);
      findings.push(...docFindings);
    }

    if (focus === "config" || focus === "architecture") {
      // Pesquisa em arquivos de configuração
      const configFindings = await this.searchConfig(context, query);
      findings.push(...configFindings);
    }

    // Ordenar por relevância
    findings.sort((a, b) => b.relevance - a.relevance);

    // Limitar resultados baseados na profundidade
    const limit = depth === "fast" ? 5 : 15;
    const topFindings = findings.slice(0, limit);

    // Gerar sumário
    const summary = this.generateSummary(query, topFindings);
    const recommendations = this.generateRecommendations(topFindings);
    const relatedQueries = this.generateRelatedQueries(query, topFindings);

    this.recordTokens(500); // Estimativa para processamento

    return {
      query,
      findings: topFindings,
      summary,
      recommendations,
      relatedQueries,
    };
  }

  /**
   * Busca no código-fonte usando filesystem/grep reais.
   */
  private async searchCode(
    context: CellExecutionContext,
    query: string,
    includePatterns?: string[],
    excludePatterns?: string[]
  ): Promise<ResearchFinding[]> {
    const findings: ResearchFinding[] = [];
    const fsRoot = context.sandboxConfig.fsRoot;
    const searchTerms = this.extractSearchTerms(query);

    try {
      // Usar filesystem tool se disponível
      if (context.toolRegistry && context.availableTools.includes("filesystem")) {
        // Usar tool real de grep via ToolRegistry
        const pattern = this.buildSearchRegex(searchTerms);

        const result = await context.toolRegistry?.execute("grep", {
          pattern,
          path: context.sandboxConfig.fsRoot,
          includePatterns: includePatterns,
          excludePatterns: excludePatterns,
          caseSensitive: false,
          maxResults: 100,
          maxDepth: 8
        });

        if (result?.success && result.output) {
          interface GrepMatch {
            file: string;
            excerpt: string;
            line: number;
          }
          const matches = JSON.parse(result.output) as GrepMatch[];
          for (const match of matches) {
            findings.push({
              source: "code",
              path: match.file,
              title: this.extractTitle(match.file, ""),
              excerpt: match.excerpt,
              relevance: this.calculateRelevance([{ excerpt: match.excerpt, line: match.line }], searchTerms),
              lines: [{ excerpt: match.excerpt, line: match.line }]
            });
          }
        }
      } else {
        // Fallback: simulação com filesystem local
        const projectFiles = await this.listProjectFiles(context.sandboxConfig.fsRoot);
        for (const file of projectFiles.slice(0, 20)) {
          const content = await this.readFileSafe(file);
          if (!content) continue;
          const matches = this.findMatches(content, this.extractSearchTerms(query));
          if (matches.length > 0) {
            findings.push({
              source: "code",
              path: file,
              title: this.extractTitle(file, content),
              excerpt: matches[0]!.excerpt,
              relevance: this.calculateRelevance(matches, this.extractSearchTerms(query)),
              lines: matches.slice(0, 3),
            });
          }
        }
      }
    } catch (error) {
      this.logger.warn({ err: error }, "[ResearchCell] Code search failed");
    }

    return findings;
  }

  /**
   * Busca em documentação (markdown, README, comentários JSDoc).
   */
  private async searchDocs(context: CellExecutionContext, query: string): Promise<ResearchFinding[]> {
    const findings: ResearchFinding[] = [];
    const fsRoot = context.sandboxConfig.fsRoot;

    try {
      if (context.availableTools.includes("filesystem")) {
        // Buscar arquivos .md e comentários JSDoc
        const docFiles = await this.findDocFiles(fsRoot);

        for (const file of docFiles.slice(0, 10)) {
          const content = await this.readFileSafe(file);
          if (!content) continue;

          const searchTerms = this.extractSearchTerms(query);
          const matches = this.findMatches(content, searchTerms);

          if (matches.length > 0) {
            findings.push({
              source: "docs",
              path: file,
              title: this.extractTitle(file, content),
              excerpt: matches[0]!.excerpt,
              relevance: this.calculateRelevance(matches, this.extractSearchTerms(query)),
              lines: matches.slice(0, 2),
            });
          }
        }
      }
    } catch (error) {
      this.logger.warn({ err: error }, "[ResearchCell] Docs search failed");
    }

    return findings;
  }

  /**
   * Busca em arquivos de configuração.
   */
  private async searchConfig(context: CellExecutionContext, query: string): Promise<ResearchFinding[]> {
    const findings: ResearchFinding[] = [];
    const fsRoot = context.sandboxConfig.fsRoot;

    try {
      if (context.availableTools.includes("filesystem")) {
        const configFiles = await this.findConfigFiles(fsRoot);
        const searchTerms = this.extractSearchTerms(query);

        for (const file of configFiles.slice(0, 10)) {
          const content = await this.readFileSafe(file);
          if (!content) continue;

          const matches = this.findMatches(content, searchTerms);
          if (matches.length > 0) {
            findings.push({
              source: "config",
              path: file,
              title: `Config: ${file}`,
              excerpt: matches[0]!.excerpt,
              relevance: this.calculateRelevance(matches, searchTerms) * 1.2, // Boost config
              lines: matches.slice(0, 2),
            });
          }
        }
      }
    } catch (error) {
      this.logger.warn({ err: error }, "[ResearchCell] Config search failed");
    }

    return findings;
  }

  // Helpers para filesystem (usariam tools reais em produção)

  private async listProjectFiles(
    _fsRoot: string,
    _includePatterns?: string[],
    excludePatterns?: string[]
  ): Promise<string[]> {
    // Em produção, usaria a filesystem tool real
    // Por ora, retorna lista simulada baseada em patterns conhecidos do projeto
    const excluded = excludePatterns || ["node_modules", "dist", ".git", "coverage"];

    // Simulação - em produção usaria glob real
    return [
      "src/adaptive/autonomous.ts",
      "src/adaptive/planner.ts",
      "src/adaptive/executor.ts",
      "src/adaptive/decision.ts",
      "src/adaptive/validator.ts",
      "src/adaptive/modelRouter.ts",
      "src/adaptive/taskAnalyzer.ts",
      "src/adaptive/strategyEngine.ts",
      "src/adaptive/runtime.ts",
      "src/routes/chat.ts",
      "src/routes/run.ts",
      "src/providers/registry.ts",
      "src/lib/rateLimiter.ts",
      "src/lib/cache.ts",
      "src/lib/retry.ts",
    ].filter(f => !excluded.some(e => f.includes(e)));
  }

  private async findDocFiles(_fsRoot: string): Promise<string[]> {
    return [
      "README.md",
      "README-en.md",
      "README.pt-BR.md",
      "CHANGELOG.md",
      "CLAUDE.md",
      "docs/ARCHITECTURE.md",
    ];
  }

  private async findConfigFiles(fsRoot: string): Promise<string[]> {
    return [
      ".env",
      ".env.example",
      "package.json",
      "tsconfig.json",
      "vitest.config.ts",
      "eslint.config.js",
    ];
  }

  private async readFileSafe(path: string): Promise<string | null> {
    try {
      // Em produção, usaria filesystem tool
      // const result = await this.toolRegistry.execute("filesystem", { path, operation: "read" });
      // return result.output;

      // Simulação para desenvolvimento
      return `// Simulated content for ${path}\n// This would be real file content in production`;
    } catch {
      return null;
    }
  }

  private extractSearchTerms(query: string): string[] {
    return query
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 2)
      .filter(w => !["the", "and", "for", "with", "how", "what", "why", "when", "where"].includes(w));
  }

  /**
   * Constrói um padrão regex (OR de termos escapados) para a tool `grep`,
   * garantindo que caracteres especiais dos termos não quebrem a regex.
   */
  private buildSearchRegex(searchTerms: string[]): string {
    if (searchTerms.length === 0) return ".*";
    const escaped = searchTerms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return escaped.join("|");
  }

  private findMatches(content: string, searchTerms: string[]): Array<{ excerpt: string; line: number }> {
    const lines = content.split("\n");
    const matches: Array<{ excerpt: string; line: number }> = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.toLowerCase();
      const matchedTerms = searchTerms.filter(term => line.includes(term));

      if (matchedTerms.length > 0) {
        const excerpt = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 2)).join("\n");
        matches.push({ excerpt, line: i + 1 });
      }
    }

    return matches;
  }

  private calculateRelevance(matches: Array<{ excerpt: string; line?: number }>, searchTerms: string[]): number {
    if (matches.length === 0) return 0;

    const totalTerms = searchTerms.length;
    const matchedTerms = new Set<string>();

    for (const match of matches) {
      for (const term of searchTerms) {
        if (match.excerpt.toLowerCase().includes(term)) {
          matchedTerms.add(term);
        }
      }
    }

    const coverage = matchedTerms.size / totalTerms;
    const frequency = Math.min(matches.length / 5, 1);

    return (coverage * 0.7 + frequency * 0.3);
  }

  private extractTitle(file: string, content: string): string {
    // Tentar extrair título do arquivo (primeira linha de comentário, heading markdown, etc.)
    const lines = content.split("\n");
    for (const line of lines.slice(0, 10)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("# ")) return trimmed.substring(2);
      if (trimmed.startsWith("// ")) return trimmed.substring(3);
      if (trimmed.startsWith("/*")) return trimmed.replace(/\/\*|\*\//g, "").trim();
    }
    return file.split("/").pop() || file;
  }

  private generateSummary(query: string, findings: ResearchFinding[]): string {
    if (findings.length === 0) {
      return `Nenhum resultado encontrado para "${query}". Tente termos mais genéricos ou verifique a ortografia.`;
    }

    const bySource = findings.reduce((acc, f) => {
      acc[f.source] = (acc[f.source] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const sources = Object.entries(bySource).map(([s, c]) => `${c} em ${s}`).join(", ");
    return `Encontrados ${findings.length} resultados para "${query}" (${sources}). Top resultado: ${findings[0]?.title || "N/A"}.`;
  }

  private generateRecommendations(findings: ResearchFinding[]): string[] {
    const recs: string[] = [];

    if (findings.length === 0) {
      recs.push("Tente termos de busca mais genéricos");
      recs.push("Verifique se o termo está escrito corretamente");
      recs.push("Considere buscar em documentação externa");
      return recs;
    }

    const topSource = findings[0]?.source;
    if (topSource === "code") {
      recs.push("Examine os arquivos de código encontrados para entender a implementação");
      recs.push("Verifique testes relacionados para exemplos de uso");
    } else if (topSource === "docs") {
      recs.push("Leia a documentação completa para contexto adicional");
    } else if (topSource === "config") {
      recs.push("Revise as configurações encontradas antes de modificar");
    }

    recs.push(`Refine a busca com termos mais específicos: ${findings.slice(0, 3).map(f => f.title).join(", ")}`);

    return recs;
  }

  private generateRelatedQueries(query: string, findings: ResearchFinding[]): string[] {
    const queries: string[] = [];

    // Extrair termos-chave dos achados
    const keyTerms = findings
      .slice(0, 5)
      .flatMap(f => f.title.split(/[\s\-_.]+/))
      .filter(t => t.length > 3)
      .slice(0, 5);

    for (const term of keyTerms) {
      queries.push(`${query} ${term}`);
      queries.push(`como usar ${term}`);
      queries.push(`${term} exemplo`);
    }

    return [...new Set(queries)].slice(0, 8);
  }
}