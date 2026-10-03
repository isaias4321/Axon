/**
 * Fase 9 — PlanningCell.
 *
 * Célula responsável por transformar objetivos em planos estruturados.
 * Suporta contextos: feature, refactor, debug, architecture.
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
import type { Plan, PlanStep } from "../../adaptive/types.js";
import type { TaskProfile } from "../../adaptive/taskAnalyzer.js";

export interface PlanningInput extends CellInput {
  type: "plan_request";
  payload: {
    goal: string;
    context?: "feature" | "refactor" | "debug" | "architecture" | "general";
    constraints?: string[];
    horizon?: "short" | "medium" | "long";
    maxSteps?: number;
  };
}

export interface PlanItem {
  id: string;
  title: string;
  description: string;
  dependencies: string[];
  estimatedEffort: "S" | "M" | "L" | "XL";
  priority: "critical" | "high" | "medium" | "low";
  context: string;
  suggestedFiles?: string[];
  capability: string;
}

export interface PlanTimelinePhase {
  name: string;
  items: string[];
  duration: string;
  deliverables: string[];
}

export interface PlanRisk {
  description: string;
  likelihood: "high" | "medium" | "low";
  impact: "high" | "medium" | "low";
  mitigation: string;
}

export interface PlanningOutput {
  goal: string;
  plan: PlanItem[];
  timeline: PlanTimelinePhase[];
  risks: PlanRisk[];
  assumptions: string[];
  successCriteria: string[];
  context: string;
}

export class PlanningCell extends BaseCognitiveCell<PlanningInput, PlanningOutput> {
  public readonly id: CellId = "planning-cell-1";
  public readonly type: CellType = "planning";
  public readonly name = "PlanningCell";
  public readonly capabilities: CellCapability[] = [
    "plan_generation",
    "replanning",
  ];
  public readonly description = "Transforma objetivos em planos estruturados com timeline, riscos e critérios de sucesso";

  protected async executeImpl(input: PlanningInput, context: CellExecutionContext): Promise<PlanningOutput> {
    const { goal, context: planContext = "general", constraints = [], horizon = "medium", maxSteps = 8 } = input.payload;

    this.recordTokens(200);

    // 1. Analisar objetivo e contexto
    const analysis = this.analyzeGoal(goal, planContext);

    // 2. Gerar plano estruturado
    const plan = this.generatePlan(goal, planContext, analysis, constraints, maxSteps);

    // 3. Gerar timeline
    const timeline = this.generateTimeline(plan, horizon);

    // 4. Identificar riscos
    const risks = this.identifyRisks(goal, planContext, plan);

    // 5. Extrair premissas
    const assumptions = this.extractAssumptions(goal, planContext, constraints);

    // 6. Definir critérios de sucesso
    const successCriteria = this.defineSuccessCriteria(goal, planContext, plan);

    this.recordTokens(300);

    return {
      goal,
      plan,
      timeline,
      risks,
      assumptions,
      successCriteria,
      context: planContext,
    };
  }

  /**
   * Analisa o objetivo para inferir contexto e complexidade.
   */
  private analyzeGoal(goal: string, context: string): {
    complexity: "low" | "medium" | "high";
    keyTerms: string[];
    implications: string[];
  } {
    const terms = goal.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const implications: string[] = [];

    // Inferir complexidade
    let complexity: "low" | "medium" | "high" = "medium";
    const highComplexityTerms = ["distributed", "redis", "kubernetes", "microservices", "rate limiting", "concurrency", "parallel", "orquestrad"];
    const lowComplexityTerms = ["simples", "pequeno", "rápido", "update", "corrigir"];

    if (highComplexityTerms.some(t => goal.toLowerCase().includes(t))) complexity = "high";
    if (lowComplexityTerms.some(t => goal.toLowerCase().includes(t))) complexity = "low";

    // Implicações
    if (goal.toLowerCase().includes("redis") || goal.toLowerCase().includes("distribuído")) {
      implications.push("Requer infraestrutura Redis");
      implications.push("Testes de concorrência necessários");
    }
    if (goal.toLowerCase().includes("rate limit")) {
      implications.push("Afeta todos os clientes");
      implications.push("Requer testes de carga");
    }

    return { complexity, keyTerms: terms, implications };
  }

  /**
   * Gera plano estruturado baseado no contexto.
   */
  private generatePlan(
    goal: string,
    context: string,
    analysis: ReturnType<typeof this.analyzeGoal>,
    constraints: string[],
    maxSteps: number
  ): PlanItem[] {
    // Templates por contexto
    const templates: Record<string, Array<Omit<PlanItem, "id" | "dependencies" | "context">>> = {
      feature: [
        { title: "Levantamento de requisitos", description: "Coletar e documentar requisitos funcionais e não-funcionais da feature", estimatedEffort: "S", priority: "critical", capability: "analise", suggestedFiles: [] },
        { title: "Análise de impacto", description: "Verificar como a feature afeta os componentes existentes", estimatedEffort: "S", priority: "high", capability: "analise", suggestedFiles: [] },
        { title: "Decisão de design", description: "Escolher a abordagem de implementação (arquitetura, padrões)", estimatedEffort: "M", priority: "high", capability: "planejamento", suggestedFiles: [] },
        { title: "Implementação", description: "Desenvolver a feature seguindo o design escolhido", estimatedEffort: "L", priority: "critical", capability: "geracao_codigo", suggestedFiles: ["src/"] },
        { title: "Testes unitários e de integração", description: "Criar e executar testes cobrindo a nova funcionalidade", estimatedEffort: "M", priority: "high", capability: "validacao", suggestedFiles: ["test/"] },
        { title: "Code review", description: "Revisar o código com foco em correctness, security e performance", estimatedEffort: "M", priority: "high", capability: "validacao", suggestedFiles: [] },
        { title: "Documentação e deploy", description: "Atualizar documentação e preparar release", estimatedEffort: "S", priority: "medium", capability: "planejamento", suggestedFiles: ["README.md"] },
      ],
      refactor: [
        { title: "Análise do código atual", description: "Mapear estrutura atual, dependências e pontos de melhoria", estimatedEffort: "M", priority: "critical", capability: "analise", suggestedFiles: ["src/"] },
        { title: "Definição de safety net", description: "Garantir testes existentes como rede de segurança", estimatedEffort: "M", priority: "critical", capability: "validacao", suggestedFiles: ["test/"] },
        { title: "Refatoração incremental", description: "Aplicar mudanças em pequenas etapas verificáveis", estimatedEffort: "L", priority: "high", capability: "geracao_codigo", suggestedFiles: ["src/"] },
        { title: "Validação por etapa", description: "Executar testes após cada mudança incremental", estimatedEffort: "M", priority: "high", capability: "validacao", suggestedFiles: ["test/"] },
        { title: "Verificação de performance", description: "Comparar performance antes/depois da refatoração", estimatedEffort: "S", priority: "medium", capability: "validacao", suggestedFiles: [] },
      ],
      debug: [
        { title: "Reprodução do erro", description: "Reproduzir o erro em ambiente controlado", estimatedEffort: "S", priority: "critical", capability: "analise", suggestedFiles: ["test/"] },
        { title: "Isolamento da causa", description: "Identificar o componente e linha exata da falha", estimatedEffort: "M", priority: "critical", capability: "analise", suggestedFiles: ["src/"] },
        { title: "Teste de hipóteses", description: "Testar hipóteses de causa raiz com evidências", estimatedEffort: "M", priority: "high", capability: "validacao", suggestedFiles: [] },
        { title: "Implementação do fix", description: "Aplicar a correção identificada", estimatedEffort: "S", priority: "high", capability: "geracao_codigo", suggestedFiles: ["src/"] },
        { title: "Teste de regressão", description: "Verificar que o fix não quebrou outras funcionalidades", estimatedEffort: "M", priority: "high", capability: "validacao", suggestedFiles: ["test/"] },
        { title: "Monitoramento", description: "Configurar monitoramento para prevenir recorrência", estimatedEffort: "S", priority: "medium", capability: "planejamento", suggestedFiles: [] },
      ],
      architecture: [
        { title: "Análise do estado atual", description: "Documentar arquitetura atual, limitações e pontos de extensão", estimatedEffort: "M", priority: "critical", capability: "analise", suggestedFiles: ["docs/"] },
        { title: "Definição de requisitos", description: "Coletar requisitos de escala, performance, segurança, operabilidade", estimatedEffort: "M", priority: "critical", capability: "planejamento", suggestedFiles: [] },
        { title: "Avaliação de alternativas", description: "Comparar opções de design com matriz de decisão", estimatedEffort: "L", priority: "high", capability: "planejamento", suggestedFiles: [] },
        { title: "Protótipo/Spike", description: "Validar viabilidade técnica da solução escolhida", estimatedEffort: "M", priority: "high", capability: "geracao_codigo", suggestedFiles: ["src/"] },
        { title: "Plano de migração", description: "Definir fases de migração com rollback seguro", estimatedEffort: "M", priority: "high", capability: "planejamento", suggestedFiles: [] },
        { title: "Rollout", description: "Implementar e validar em staging antes de produção", estimatedEffort: "L", priority: "high", capability: "geracao_codigo", suggestedFiles: ["src/"] },
      ],
      general: [
        { title: "Clarificação do objetivo", description: "Garantir entendimento completo do objetivo", estimatedEffort: "S", priority: "critical", capability: "analise", suggestedFiles: [] },
        { title: "Avaliação do estado atual", description: "Verificar o que já existe e o que precisa ser feito", estimatedEffort: "M", priority: "high", capability: "analise", suggestedFiles: ["src/"] },
        { title: "Identificação de gaps", description: "Mapear lacunas entre estado atual e objetivo", estimatedEffort: "M", priority: "high", capability: "planejamento", suggestedFiles: [] },
        { title: "Execução", description: "Executar as ações necessárias para fechar os gaps", estimatedEffort: "L", priority: "critical", capability: "geracao_codigo", suggestedFiles: ["src/"] },
        { title: "Validação", description: "Verificar que o objetivo foi alcançado", estimatedEffort: "M", priority: "high", capability: "validacao", suggestedFiles: ["test/"] },
      ],
    };

    const template = templates[context] ?? templates.general ?? [];

    // Adaptar número de steps ao maxSteps
    const adjusted = template.slice(0, maxSteps);

    // Gerar itens com IDs e dependências
    const plan: PlanItem[] = adjusted.map((item, idx) => ({
      ...item,
      id: `${context}-${idx + 1}`,
      dependencies: idx > 0 ? [`${context}-${idx}`] : [],
      context,
    }));

    // Adicionar constraints como etapas iniciais se aplicável
    if (constraints.length > 0 && plan.length > 0) {
      plan[0]!.description += ` (Restrições: ${constraints.join(", ")})`;
    }

    return plan;
  }

  /**
   * Gera timeline a partir do plano.
   */
  private generateTimeline(plan: PlanItem[], horizon: string): PlanTimelinePhase[] {
    const phases: PlanTimelinePhase[] = [];
    const itemsPerPhase = Math.ceil(plan.length / 3);

    // Determinar duração baseada no horizon
    const totalDays = horizon === "short" ? 3 : horizon === "long" ? 30 : 14;
    const daysPerPhase = Math.ceil(totalDays / 3);

    for (let i = 0; i < plan.length; i += itemsPerPhase) {
      const phaseItems = plan.slice(i, i + itemsPerPhase);
      const phaseStart = (i / itemsPerPhase) * daysPerPhase + 1;
      const phaseEnd = phaseStart + daysPerPhase - 1;

      phases.push({
        name: `Fase ${phases.length + 1}`,
        items: phaseItems.map(p => p.title),
        duration: `Dia ${phaseStart}–${phaseEnd}`,
        deliverables: phaseItems.map(p => p.title),
      });
    }

    return phases;
  }

  /**
   * Identifica riscos do plano.
   */
  private identifyRisks(goal: string, context: string, plan: PlanItem[]): PlanRisk[] {
    const risks: PlanRisk[] = [];

    // Riscos baseados no contexto
    const contextRisks: Record<string, PlanRisk[]> = {
      feature: [
        { description: "Requisitos podem mudar durante o desenvolvimento", likelihood: "medium", impact: "medium", mitigation: "Documentar requisitos claramente e congelar após aprovação" },
        { description: "A feature pode quebrar funcionalidades existentes", likelihood: "medium", impact: "high", mitigation: "Testes de regressão completos antes do deploy" },
      ],
      refactor: [
        { description: "Refatoração pode introduzir bugs sutis", likelihood: "high", impact: "high", mitigation: "Manter testes existentes como safety net e aplicar mudanças incrementais" },
        { description: "Tempo de refatoração pode exceder estimativa", likelihood: "medium", impact: "medium", mitigation: "Dividir em etapas pequenas e prioritizar impacto" },
      ],
      debug: [
        { description: "Causa raiz pode não ser a esperada", likelihood: "medium", impact: "high", mitigation: "Validar hipóteses com evidências antes de implementar fix" },
        { description: "Fix pode introduzir novos problemas", likelihood: "medium", impact: "medium", mitigation: "Testes de regressão após cada fix" },
      ],
      architecture: [
        { description: "Arquitetura escolhida pode não escalar como esperado", likelihood: "medium", impact: "high", mitigation: "Protótipos e testes de carga antes de comprometer" },
        { description: "Migração pode ter downtime", likelihood: "medium", impact: "high", mitigation: "Estratégia de rollout incremental com rollback" },
      ],
      general: [
        { description: "Escopo pode crescer durante a execução", likelihood: "medium", impact: "medium", mitigation: "Definir critérios de aceite claros" },
        { description: "Dependências externas podem atrasar", likelihood: "medium", impact: "medium", mitigation: "Identificar dependências cedo e planejar mitigação" },
      ],
    };

    risks.push(...(contextRisks[context] ?? contextRisks.general ?? []));

    // Risco se plan tem muitos itens de prioridade crítica
    const criticalCount = plan.filter(p => p.priority === "critical").length;
    if (criticalCount > 2) {
      risks.push({
        description: `Muitas etapas críticas (${criticalCount}) aumentam risco de falha total`,
        likelihood: "medium",
        impact: "high",
        mitigation: "Identificar qual etapa é a mais arriscada e priorizar",
      });
    }

    return risks.slice(0, 4);
  }

  /**
   * Extrai premissas do plano.
   */
  private extractAssumptions(goal: string, context: string, constraints: string[]): string[] {
    const assumptions: string[] = [];

    assumptions.push(`A tarefa pode ser completada com os recursos atuais do projeto`);
    assumptions.push(`Ferramentas e providers configurados estão disponíveis e funcionando`);

    if (context === "architecture") {
      assumptions.push("Há requisitos de escala claros que justificam a arquitetura");
    }
    if (context === "refactor") {
      assumptions.push("Existem testes existentes cobrindo o código a refatorar");
    }
    if (context === "debug") {
      assumptions.push("O erro é reprodutível em ambiente de desenvolvimento");
    }

    if (constraints.length > 0) {
      assumptions.push(`Restrições consideradas: ${constraints.join(", ")}`);
    }

    return assumptions;
  }

  /**
   * Define critérios de sucesso.
   */
  private defineSuccessCriteria(goal: string, context: string, plan: PlanItem[]): string[] {
    const criteria: string[] = [];

    criteria.push(`Objetivo alcançado: ${goal}`);
    criteria.push("Todos os passos do plano concluídos e validados");
    criteria.push("Testes existentes continuam passando (regressão F1–F8)");

    if (context === "feature") {
      criteria.push("Nova funcionalidade coberta por testes");
      criteria.push("Documentação atualizada");
    } else if (context === "refactor") {
      criteria.push("Código refatorado sem alterar comportamento");
      criteria.push("Performance igual ou melhor");
    } else if (context === "debug") {
      criteria.push("Erro não reproduz mais");
      criteria.push("Teste de regressão adicionado para o erro corrigido");
    } else if (context === "architecture") {
      criteria.push("Protótipo valida viabilidade técnica");
      criteria.push("Plano de migração documentado e aprovado");
    }

    return criteria;
  }

  /**
   * Converte plano de célula para plano do motor autônomo (integração F6).
   */
  toAutonomousPlan(plan: PlanItem[], taskProfile: TaskProfile): Plan {
    const steps: PlanStep[] = plan.map((item, idx) => ({
      id: item.id,
      index: idx,
      description: item.title,
      objective: item.description,
      capability: (item.capability as unknown as TaskProfile["capabilities"][number]) || "raciocinio",
      dependencies: item.dependencies,
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
    }));

    return {
      id: `plan-cell-${Date.now()}`,
      steps,
      nextStepId: steps.length > 0 ? steps[0]!.id : null,
    };
  }
}