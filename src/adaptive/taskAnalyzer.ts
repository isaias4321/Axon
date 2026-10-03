/**
 * Fase 1 — Adaptive Core.
 *
 * `analyzeTask` classifica uma tarefa em texto em um `TaskProfile`
 * determinístico (sem IO, sem chamada de LLM). As heurísticas usam
 * palavras-chave e métricas de entrada para inferir complexidade,
 * categoria e capacidades requeridas.
 *
 * Cada fator que dispara entra em `TaskProfile.hints`, o que dá
 * rastreabilidade ao resultado e serve de base de explainability
 * para fases futuras (F6 — Autonomous Behavior).
 */

export type TaskComplexity = "baixa" | "media" | "alta";
export type TaskCategory =
  | "conversacao"
  | "codigo"
  | "analise"
  | "planejamento"
  | "geral";
export type TaskCapability =
  | "conversa"
  | "geracao_codigo"
  | "analise"
  | "planejamento"
  | "validacao"
  | "raciocinio"
  | "execucao_ferramenta";

/**
 * Intenção CONCRETA de uma operação de filesystem, derivada do pedido real.
 *
 * Existe porque a presença de uma palavra ("arquivo", "criar") num texto NÃO
 * é prova de que o usuário pediu uma escrita: o verbo pode estar negado
 * ("não crie arquivos"), dentro de uma cláusula reportada ("verifique se o
 * projeto cria arquivos temporários") ou descrever algo a ser apenas LIDO.
 * Anteriormente o executor tentava `deriveFileWrite()` antes de qualquer outra
 * derivação, o que transformava tarefas read-only em escritas destrutivas
 * (arquivos sobrescritos com fragmentos do próprio enunciado).
 */
export type FilesystemIntent = "read" | "write" | "list";

export interface TaskProfile {
  text: string;
  complexity: TaskComplexity;
  category: TaskCategory;
  capabilities: TaskCapability[];
  wordCount: number;
  charCount: number;
  /**
   * Presente quando a tarefa pede uma ação concreta executável via Tool
   * Registry (filesystem, shell, http) — mesmo sinal usado por
   * `strategyEngine.ts` para decidir a estratégia `autonomous`. Exposto
   * aqui para que o Planner e o loop autônomo usem a MESMA fonte de
   * verdade em vez de cada um re-derivar isso com seu próprio regex.
   */
  toolIntent?: "filesystem" | "shell" | "http" | "document" | "compression" | "image" | "project" | null;
  /**
   * Intenção concreta do pedido de filesystem (read/write/list), quando o
   * `toolIntent` é `"filesystem"`. Fonte única usada pelo executor para
   * decidir QUAL operação derivar — nunca para "adivinhar" a partir da mera
   * presença de uma palavra no texto. `null` quando a intenção não é clara
   * ou não há pedido de filesystem.
   */
  filesystemIntent?: FilesystemIntent | null;
  /**
   * `true` quando a tarefa pede explicitamente para PARAR logo após um
   * conjunto fixo de operações ("depois pare imediatamente", "stop right
   * after", "encerre a execução em seguida"). Usado pelo Planner para
   * nunca acrescentar uma etapa extra de "formatar/validar relatório" após
   * as etapas de ferramenta que a tarefa pediu — essa etapa extra violava a
   * instrução do usuário e ainda disparava chamadas de LLM/fallback
   * desnecessárias depois que o trabalho real já tinha terminado.
   */
  stopsImmediatelyAfterTools?: boolean;
  /** Heurísticas que dispararam — rastreabilidade, extensível para F6. */
  hints: string[];
}

/** Ordem fixa de capacidades — dedup sempre preserva esta ordem. */
const CAPABILITY_ORDER: readonly TaskCapability[] = [
  "conversa",
  "geracao_codigo",
  "execucao_ferramenta",
  "analise",
  "planejamento",
  "validacao",
  "raciocinio",
];

/** Verbos que indicam tarefa complexa (análise, construção, planejamento…). */
const COMPLEX_ACTION_VERBS: ReadonlySet<string> = new Set([
  "analise",
  "analisar",
  "avalie",
  "avaliar",
  "construa",
  "construir",
  "crie",
  "criar",
  "desenvolva",
  "desenvolver",
  "projete",
  "projetar",
  "planeje",
  "planejar",
  "implemente",
  "implementar",
  "refatore",
  "refatorar",
  "identifique",
  "identificar",
  "diagnostique",
  "diagnosticar",
  "otimize",
  "otimizar",
  "compare",
  "comparar",
  "estruture",
  "estruturar",
  "desenhe",
  "desenhar",
  "elabore",
  "elaborar",
  "arquiteture",
  "arquiteturar",
  "valide",
  "validar",
  "verifique",
  "verificar",
  "revise",
  "revisar",
  "arquitetura",
]);

/** Marcadores de pedido com múltiplos artefatos / partes. */
const MULTI_ARTIFACT_PATTERN =
  /\b(1[.:]|2[.:]|primeiro|segundo|terceiro)\b|\b(v[aá]rios|m[oó]dulos?|arquivos?|etapas?|passos?|itens|lista|endpoints?|servi[çc]os?)\b/i;

/** Palavras-chave de intenção de planejamento. */
const PLANNING_KEYWORDS: ReadonlySet<string> = new Set([
  "arquitetura",
  "projete",
  "projetar",
  "projeto",
  "planeje",
  "planejar",
  "planejamento",
  "roadmap",
  "estrutura",
  "design",
  "arquitetar",
  "fases",
  "etapas",
  "milestones",
  "estruturar",
]);

/** Palavras-chave de intenção de código. */
const CODE_KEYWORDS: ReadonlySet<string> = new Set([
  "código",
  "codigo",
  "python",
  "javascript",
  "typescript",
  "api",
  "bug",
  "refatorar",
  "refatore",
  "função",
  "funcao",
  "classe",
  "classes",
  "testes",
  "sql",
  "fastapi",
  "docker",
  "endpoint",
  "rota",
  "commit",
  "script",
  "node",
  "fastify",
  "banco",
  "postgres",
  "backend",
  "frontend",
]);

/** Palavras-chave de intenção de análise. */
const ANALYSIS_KEYWORDS: ReadonlySet<string> = new Set([
  "analise",
  "analisar",
  "revise",
  "revisar",
  "avalie",
  "avaliar",
  "problemas",
  "diagnóstico",
  "diagnostico",
  "comparação",
  "comparacao",
  "compare",
  "comparar",
  "desempenho",
  "custo-benefício",
  "custo-beneficio",
  "revisão",
  "revisao",
  "impacto",
  "métricas",
  "metricas",
  "qualidade",
]);

/** Palavras-chave de validação (refino de capabilities). */
const VALIDATION_KEYWORDS: ReadonlySet<string> = new Set([
  "teste",
  "testes",
  "testar",
  "validar",
  "valide",
  "verifique",
  "verificar",
  "review",
  "revisar",
  "revisão",
  "revisao",
]);

/** Cumprimentos que indicam conversa. */
const GREETING_PATTERN =
  /^(ol[áa]|oi|e a[ií]|bom dia|boa tarde|boa noite|tudo bem|obrigad|valeu|hello|hi)\b/i;

function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/**
 * Classifica a complexidade por pontuação.
 * `0 → baixa`, `1–2 → media`, `>= 3 → alta`.
 */
export function classifyComplexity(
  text: string,
  wordCount: number,
  charCount: number
): { complexity: TaskComplexity; hints: string[] } {
  const hints: string[] = [];
  let score = 0;

  if (wordCount >= 90) {
    score += 2;
    hints.push(`contexto grande (${wordCount} palavras)`);
  } else if (wordCount >= 15) {
    score += 1;
    hints.push(`médio (${wordCount} palavras)`);
  } else {
    hints.push(`curto (${wordCount} palavras)`);
  }

  const matchedVerbs = [...COMPLEX_ACTION_VERBS].filter((verb) =>
    text.includes(verb)
  );
  if (matchedVerbs.length >= 2) {
    score += 2;
    hints.push(`verbos complexos: ${matchedVerbs.join(", ")}`);
  } else if (matchedVerbs.length === 1) {
    score += 1;
    hints.push(`verbo complexo: ${matchedVerbs[0]}`);
  }

  if (MULTI_ARTIFACT_PATTERN.test(text)) {
    score += 1;
    hints.push("multi-artefato");
  }

  if (charCount >= 1500) {
    score += 1;
    hints.push("texto extenso");
  }

  if (/([{}()])/.test(text)) {
    score += 1;
    hints.push("código embutido");
  }

  let complexity: TaskComplexity;
  if (score >= 3 || matchedVerbs.length >= 2) complexity = "alta";
  else if (score >= 1) complexity = "media";
  else complexity = "baixa";

  return { complexity, hints };
}

function hasKeyword(text: string, keywords: ReadonlySet<string>): string[] {
  return [...keywords].filter((keyword) =>
    new RegExp(`\\b${escapeRegExp(keyword)}\\b`, "i").test(text)
  );
}

/** Escapa caracteres especiais de regex para uso em um padrão literal. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Detecta se a frase é uma pergunta sobre capacidades/habilidades do agente
 * (ex.: "você consegue criar um arquivo win.rar?", "sabe editar fotos?", "é possível compactar?"),
 * em vez de uma instrução concreta de escrita/execução em disco.
 */
export function isCapabilityQuestion(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase().trim();
  const isQuestion = lower.endsWith("?");
  // Nota: o \b antes de "[eé]" foi trocado por (?:^|\s) porque \b não conta
  // "é" como caractere de palavra (regex JS sem unicode word class) — então
  // "\b[eé] possível\b" nunca batia com a forma acentuada bem comum em
  // início de frase ("É possível...?"), só com a forma sem acento.
  const capabilityPattern = /\b(voc[êe] )?(consegue|sabe|pode|conseguiria|saberia|poderia|sabe como)\b|\bd[áa] para\b|(?:^|\s)[eé] poss[íi]vel\b|\bcomo (faz|criar|compactar|funciona)\b/i;
  const matchesCapability = capabilityPattern.test(lower);

  // Se houver comando de execução afirmativo explícito com alvo concreto (ex.: "Crie o arquivo X...")
  const hasExplicitCommand = /\b(crie|escreva|salve|compacte|redimensione|rode|execute)\s+([a-z0-9_.-]+)/i.test(lower);

  // "Consegue criar X?" sozinho é ambíguo — pode ser uma pergunta de
  // capacidade de verdade OU um pedido educado disfarçado de pergunta (muito
  // comum em português: "consegue fazer isso pra mim?" == "por favor, faça
  // isso"). O sinal que desambigua é uma cláusula pedindo para RECEBER o
  // resultado ("...e me manda/envia por...") — isso significa que a pessoa
  // quer o entregável de verdade, não uma resposta em texto sobre se é
  // possível. Ex.: "consegue criar um projeto básico e me mandar por zip?"
  // deve ser tratado como pedido de ação (tenta cumprir, e se não der,
  // explica o motivo real via o fallback do loop autônomo), não como
  // pergunta de capacidade pura (que nunca tentava executar nada).
  const wantsDeliverable = /\b(me |nos )?(mand|envi)[ae]/i.test(lower);

  return (isQuestion || matchesCapability) && matchesCapability && !hasExplicitCommand && !wantsDeliverable;
}

/**
 * Classifica a categoria. A PRIMEIRA intenção que casar vence — a ordem
 * importa: planejamento > código > análise > conversa > geral.
 */
export function classifyCategory(
  normalized: string
): { category: TaskCategory; hints: string[] } {
  const wordCount = wordsOf(normalized).length;
  const hints: string[] = [];

  if (isCapabilityQuestion(normalized)) {
    hints.push("pergunta de capacidade");
    return { category: "conversacao", hints };
  }

  const planning = hasKeyword(normalized, PLANNING_KEYWORDS);
  if (planning.length > 0) {
    hints.push(`planejamento: ${planning.join(", ")}`);
    return { category: "planejamento", hints };
  }

  const code = hasKeyword(normalized, CODE_KEYWORDS);
  if (code.length > 0) {
    hints.push(`código: ${code.join(", ")}`);
    return { category: "codigo", hints };
  }

  const analysis = hasKeyword(normalized, ANALYSIS_KEYWORDS);
  if (analysis.length > 0) {
    hints.push(`análise: ${analysis.join(", ")}`);
    return { category: "analise", hints };
  }

  const isGreeting = GREETING_PATTERN.test(normalized);
  const isShortQuestion =
    normalized.trim().endsWith("?") && wordCount <= 12;
  const isVeryShort = wordCount < 8;

  if (isGreeting || isShortQuestion || isVeryShort) {
    hints.push(
      isGreeting
        ? "cumprimento"
        : isShortQuestion
          ? "pergunta curta"
          : "texto muito curto"
    );
    return { category: "conversacao", hints };
  }

  hints.push("nenhuma intenção detectada");
  return { category: "geral", hints };
}

function dedupInOrder(capabilities: TaskCapability[]): TaskCapability[] {
  const seen = new Set<TaskCapability>();
  const result: TaskCapability[] = [];
  for (const cap of CAPABILITY_ORDER) {
    if (capabilities.includes(cap)) {
      seen.add(cap);
      result.push(cap);
    }
  }
  return result;
}

/**
 * Deteta se a tarefa pede uma ação concreta executável via Tool Registry
 * (filesystem, shell ou http). Ordem determinística: arquivo → comando → URL.
 * Fonte única de verdade — usada tanto para decidir a estratégia
 * `autonomous` (`strategyEngine.ts`) quanto para dar ao Planner e ao loop
 * autônomo (F6) a mesma informação, em vez de cada consumidor re-derivar
 * isso com seu próprio regex (o que gerava falsos positivos: um passo de
 * *planejamento* que apenas menciona a palavra "arquivo" de passagem não
 * deveria ser tratado como um passo de execução de ferramenta).
 */
/**
 * Detecta pedidos de GERAÇÃO de imagem nova a partir de uma descrição em
 * texto (ex.: "crie uma imagem de um gato", "gere uma foto de praia").
 * Isso NÃO existe no ImageTool (que só edita imagens já existentes no
 * workspace — resize/crop/filtro/formato, ver src/adaptive/tools/imageTool.ts)
 * — sem esse filtro, `detectToolIntent` mandava esses pedidos para o loop
 * autônomo, que tentava chamar a tool de edição com um `inputPath`
 * inventado, sempre falhava e desistia depois de várias iterações sem
 * nunca explicar ao usuário que geração de imagem simplesmente não está
 * disponível. Um pedido que referencia uma imagem EXISTENTE (extensão de
 * arquivo, "editar", "redimensionar" etc.) não conta como geração.
 */
function isImageGenerationRequest(lower: string): boolean {
  const mentionsImage = /\b(imagem|foto|figura|ilustra[cç][ãa]o)\b/.test(lower);
  if (!mentionsImage) return false;

  const generationVerb = /\b(crie|criar|cria|gere|gerar|gera|fa[cç]a|fazer|desenhe|desenhar|desenha|produza|produzir)\b/;
  if (!generationVerb.test(lower)) return false;

  const referencesExistingImage =
    /\.(png|jpe?g|webp|gif|bmp|svg)\b|anexei|anexo|enviei|upload|editar|edite|redimensionar|redimensione|cortar|corte|recortar|girar|rotacionar|aplicar filtro|converter (o formato|para)/;
  return !referencesExistingImage.test(lower);
}

/**
 * Detecta pedidos de criação de um PROJETO/aplicativo com múltiplos
 * arquivos (ex.: "crie um projeto básico e me mande em zip", "monte uma
 * API simples em Python"). Isso é tratado por um caminho de execução
 * dedicado (`projectScaffold.ts`) em vez do loop autônomo genérico por
 * etapas — ver o comentário no topo daquele arquivo para o motivo.
 */
function isProjectScaffoldRequest(lower: string): boolean {
  // O verbo de criação precisa ter o PROJETO como objeto direto: só artigos
  // e adjetivos comuns podem ficar entre os dois ("crie UM projeto BÁSICO",
  // "monte UMA aplicação SIMPLES"). "Projeto" é um substantivo comum em
  // muitos pedidos que NÃO são de criação — "audite o projeto sem escrever
  // arquivos", "gere um relatório do projeto" — e nesses o verbo não tem o
  // projeto como objeto, então não devem virar scaffold. `escrever` fica de
  // fora de propósito: é verbo de escrita de arquivo (filesystem) e aparece
  // muito negado ("sem escrever arquivos").
  const filler =
    "(?:\\s+(?:um|uma|o|a|novo|nova|pequeno|pequena|simples|b[áa]sico|b[áa]sica|completo|completa|meu|minha|pra\\s+mim|para\\s+mim))*";
  const projectNoun = "(?:projeto|aplica[cç][ãa]o|aplicativo|programa|script)";
  const creationVerb =
    "(?:crie|criar|cria|fa[cç]a|fazer|monte|montar|desenvolva|desenvolver|gere|gerar|implemente|implementar)";
  const pattern = new RegExp(`\\b${creationVerb}${filler}\\s+${projectNoun}\\b`, "i");
  return hasAffirmativeMatch(lower, pattern);
}

export function detectToolIntent(
  text: string
): "filesystem" | "shell" | "http" | "document" | "compression" | "image" | "project" | null {
  if (isCapabilityQuestion(text)) {
    return null;
  }
  const lower = text.toLowerCase();
  if (isProjectScaffoldRequest(lower)) {
    return "project";
  }
  if (isImageGenerationRequest(lower)) {
    // Sem tool de geração de imagem via texto — não force o loop autônomo
    // a tentar (e falhar) chamando a tool de edição. Deixa cair para
    // single_agent, onde o próprio LLM explica a limitação diretamente.
    return null;
  }
  if (
    /\b(imagem|foto|redimensionar|cortar|filtro|grayscale|sepia|blur|whatsapp|telegram|\.png\b|\.jpg\b|\.jpeg\b|\.webp\b)/.test(lower)
  ) {
    return "image";
  }
  if (
    /\b(rar|descompactar|extrair|\.rar\b)/.test(lower)
  ) {
    return "compression";
  }
  // Ler/listar/inspecionar um .zip/.rar JÁ EXISTENTE precisa ir para
  // "compression" (que sabe listar entradas de um arquivo compactado via
  // listZipEntries), NUNCA para "document" — o DocumentTool só CRIA
  // zip/pdf/gráfico, não tem nenhuma ação de leitura. Antes desse check, uma
  // pergunta como "leia o conteúdo do arquivo x.zip" caía no branch de
  // "document" abaixo (que também bate em "\.zip\b") e falhava sempre,
  // porque não existe ação de leitura ali.
  const archiveReadVerbs =
    /\b(ler|leia|listar|liste|inspecionar|inspecione|abrir|abra|analisar|analise|conte[uú]do|fale|falar|me diga|diga-?me|explique|explicar|oq|o ?que (é|e|tem|cont[eé]m|faz) ?(esse|este|isso)?)\b/;
  // Guarda contra falso positivo: "crie um zip com o conteúdo de X" tem
  // "conteúdo" mas é claramente uma CRIAÇÃO, não uma leitura — sem isso,
  // esse tipo de pedido seria incorretamente desviado para "compression"
  // em vez de "document" (ver regressão real corrigida em executor.ts, que
  // motivou este mesmo guard aqui).
  const hasCreationVerb = /\b(crie|criar|cria|compacte|compactar|compacta|gerar|gere|gera)\b/.test(lower);
  // "winrar"/"winzip" entram aqui de propósito: no português coloquial as
  // pessoas chamam qualquer arquivo compactado de "winrar" mesmo sendo na
  // verdade um .zip (ex.: "me fale o que é esse winrar" sobre um .zip
  // anexado) — sem isso, esse tipo de mensagem não batia em nenhum branch.
  if (
    !hasCreationVerb &&
    /\.zip\b|\.rar\b|\bzip\b|\brar\b|\bwinrar\b|\bwinzip\b/.test(lower) &&
    archiveReadVerbs.test(lower)
  ) {
    return "compression";
  }
  // Verificado ANTES de filesystem: "crie um pdf/zip com o conteúdo do
  // arquivo X" também contém "arquivo"/"conteudo", que bateriam no branch de
  // filesystem abaixo — a intenção de DOCUMENTO (empacotar/gerar um formato
  // específico) é mais específica e deve vencer.
  if (
    /\b(zip|compact[ae]|arquivo compactado|\.zip\b)/.test(lower) ||
    /\b(pdf|\.pdf\b)/.test(lower) ||
    /\b(gr[aá]fico|diagrama|fluxograma|chart)\b/.test(lower)
  ) {
    return "document";
  }
  if (isWorkspaceInspectionIntent(lower)) {
    return "filesystem";
  }
  if (
    /\b(criar arquivo|escrever( o)? arquivo|ler arquivo|salvar arquivo|crie (o|um|uma)? arquivo|conteudo|contendo|arquivos?)\b/.test(lower) ||
    /\.(txt|md|js|ts|json|html|css|py|go)\b/.test(lower)
  ) {
    return "filesystem";
  }
  if (
    /\b(comando|shell|terminal|rode|execute o comando|rodar o comando|executar o comando|prompt de comando)\b/.test(lower)
  ) {
    return "shell";
  }
  if (/\b(requisitar|requisita a|endpoint|fetch|buscar da api|url de api)\b/.test(lower) || /https?:\/\//.test(lower)) {
    return "http";
  }
  return null;
}

/** Detecta pedidos de inventário estrutural do workspace/projeto. */
export function isWorkspaceInspectionIntent(text: string): boolean {
  const lower = text.toLowerCase();
  const workspace = /\b(workspace|projeto|reposit[oó]rio|base de c[oó]digo|c[oó]digo-fonte)\b/i.test(lower);
  const inspection = /\b(analisar|analise|inspecionar|inspecione|listar|liste|list|mapear|mapeie|identificar|identifique|estrutura|estrutur[aá]|invent[aá]rio|organiza[cç][aã]o)\b/i.test(lower);
  const layers = /\b(frontend|front-end|backend|back-end|persist[eê]ncia|banco de dados)\b/i.test(lower);

  const structuralVerb = /\b(identificar|identifique|mapear|mapeie|inspecionar|inspecione|estrutura|estrutur[aá]|invent[aá]rio|organiza[cç][aã]o)\b/i.test(lower);

  return (workspace && inspection) || (layers && structuralVerb);
}

// ── Resolução explícita de intenção de filesystem ──────────────────────
//
// Por que não usar apenas a presença de palavras: a mesma palavra pode
// aparecer num pedido NEGADO ("não crie arquivos"), REPORTADO ("verifique se o
// projeto cria arquivos temporários") ou descrevendo uma LEITURA. A decisão
// aqui é por verbo + escopo de cláusula + negação — determinística e sem IO.

/** Verbos de ESCRITA que expressam um PEDIDO real (imperativo/infinitivo). */
const FS_WRITE_VERB =
  /\b(criar|crie|criem|escrever|escreva|escrevam|salvar|salve|salvem|gravar|grave|gravem|gerar|gere|gerem|adicionar|adicione|acrescentar|acrescente|modificar|modifique|alterar|altere|sobrescrever|sobrescreva|compactar|compacte|compactem|empacotar|zipar|zipe|zipem|rar|rarar|redimensionar|cortar|editar|write|save|create|append|overwrite)\b/i;

/** Verbos de LEITURA. */
const FS_READ_VERB =
  /\b(ler|leia|leiam|read|abrir|abra|visualizar|exibir|exiba|mostrar|mostre|explique|explicar|descreva|descrever|resuma|resumir|inspecionar|inspecione|analisar|analise|auditar|audite|verificar|verifique|confirmar|confirme)\b/i;

/** Verbos de LISTAGEM. */
const FS_LIST_VERB =
  /\b(listar|liste|listem|list|ls|mapear|mapeie|mapeamento|inventariar)\b/i;

/** Negadores que cancelam um pedido dentro do escopo da cláusula. */
const NEGATION_PATTERN =
  /\b(n[ãa]o|nunca|jamais|sem|nem|tampouco|do not|don't|dont|never|without|not)\b/i;

/**
 * Limites de cláusula usados para restringir o escopo de uma negação.
 * Conjunções contrastivas ("mas", "porém", "apenas") reiniciam o escopo:
 * em "não altere X, mas crie Y" o "não" NÃO deve negar o "crie".
 */
const CLAUSE_BOUNDARY = /[.;\n]|\b(?:mas|por[ée]m|contudo|entretanto|todavia|but|however|apenas|somente)\b/gi;

/** Texto da cláusula imediatamente anterior a `index` (sem a negação de outra cláusula). */
function precedingClause(text: string, index: number): string {
  const slice = text.slice(0, index);
  const re = new RegExp(CLAUSE_BOUNDARY.source, "gi");
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(slice)) !== null) {
    last = match.index + match[0].length;
    if (match.index === re.lastIndex) re.lastIndex += 1;
  }
  return slice.slice(last);
}

/**
 * Retorna `true` se `pattern` aparece ao menos uma vez em um contexto
 * AFIRMATIVO: sem negação na cláusula corrente e sem ser uma cláusula
 * reportada ("verifique se o projeto cria ...", que descreve, não pede).
 */
function hasAffirmativeMatch(text: string, pattern: RegExp): boolean {
  const re = new RegExp(pattern.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const before = precedingClause(text, match.index).trimEnd();
    if (NEGATION_PATTERN.test(before)) continue;
    // "verifique se o projeto cria ..." → sujeito introduzido por "se"
    // (cláusula subordinada) — descreve o comportamento, não pede a ação.
    if (/\bse\s+(?:o|a|os|as|um|uma)\s+\S+$/i.test(before)) continue;
    return true;
  }
  return false;
}

/** Existe um caminho de arquivo/diretório reconhecível no texto? */
function hasPathLike(text: string): boolean {
  return (
    /\.[a-z0-9]{1,10}\b/i.test(text) ||
    /(?:^|[\\/\s])(?:src|lib|test|tests|tmp|app|routes|public|docs|scripts|config|dist)[\\/]/i.test(text)
  );
}

/** Pedido de ESCRITA afirmativo (não negado, não reportado). */
export function hasAffirmativeWriteRequest(text: string): boolean {
  return hasAffirmativeMatch(text.toLowerCase(), FS_WRITE_VERB);
}

/**
 * Passo VAGO: menciona "arquivo/comando/requisição/ferramenta" de forma
 * genérica, sem dizer QUAL operação nem qual alvo (ex.: "Executar a ação real
 * necessária (arquivo, comando ou requisição) via ferramenta" — texto do plano
 * fallback). Não deve acionar tool: vira resposta LLM-texto em vez de falhar
 * 3x em `no_progress`.
 */
export function isVagueStepRequest(stepText: string, task: string): boolean {
  const combined = `${stepText} ${task}`.toLowerCase();
  if (/\b(arquivo|arquivos|comando|requisi[çc][aã]o|ferramenta)\b/.test(stepText.toLowerCase()) === false) {
    return false;
  }
  // Alvo concreto identificado (path/extensão/dir conhecido) → não é vago.
  if (/\.[a-z0-9]{1,10}\b/i.test(combined)) return false;
  if (/(?:^|[\s(/])(?:src|lib|test|tests|tmp|app|routes|public|docs|scripts|config|dist)[\\/]/i.test(combined)) return false;
  // Operação concreta (verbo afirmativo ou marcador de conteúdo) → não é vago.
  if (hasAffirmativeMatch(combined, FS_WRITE_VERB)) return false;
  if (hasAffirmativeMatch(combined, FS_READ_VERB)) return false;
  if (hasAffirmativeMatch(combined, FS_LIST_VERB)) return false;
  if (/\b(conte[úu]do|contendo|vazi[oa]s?)\b/i.test(combined)) return false;
  return true;
}

/** Pedido de LEITURA afirmativo (não negado, não reportado). */
export function hasAffirmativeReadRequest(text: string): boolean {
  return hasAffirmativeMatch(text.toLowerCase(), FS_READ_VERB);
}

/**
 * Resolve a intenção concreta de filesystem a partir do texto.
 *
 * Precedência:
 * 1. escrita afirmativa → `write`
 * 2. listagem afirmativa → `list`
 * 3. leitura afirmativa → `read`
 * 4. pedido de filesystem sem verbo afirmativo (ex.: só negação de escrita)
 *    mas com caminho reconhecível → `read` (default seguro, nunca escrita)
 * 5. nada claro → `null` (não derivar operação especulativa)
 */
export function detectFilesystemIntent(text: string): FilesystemIntent | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  if (detectToolIntent(lower) !== "filesystem") return null;

  if (hasAffirmativeMatch(lower, FS_WRITE_VERB)) return "write";
  // Inventário estrutural do workspace/projeto ("analise a estrutura do
  // workspace") é uma LISTAGEM na prática — o `isWorkspaceInspectionIntent`
  // já é a fonte canônica dessa intenção em `deriveFileList`.
  if (isWorkspaceInspectionIntent(lower)) return "list";
  if (hasAffirmativeMatch(lower, FS_LIST_VERB)) return "list";
  if (hasAffirmativeMatch(lower, FS_READ_VERB)) return "read";
  if (hasPathLike(lower)) return "read";
  return null;
}

/**
 * `true` quando a TAREFA (não uma etapa isolada) afirma mais de um tipo de
 * operação de filesystem ao mesmo tempo (ex.: "liste /app E leia
 * /app/package.json"). Nesse caso não existe UMA intenção única válida para
 * a tarefa inteira — cada etapa tem a sua própria, e `resolveFilesystemIntent`
 * precisa da etapa para desempatar em vez de aplicar cegamente a primeira
 * intenção encontrada no texto combinado a TODAS as etapas.
 */
function hasMultipleFilesystemOperations(text: string): boolean {
  const lower = text.toLowerCase();
  const signals = [
    hasAffirmativeMatch(lower, FS_WRITE_VERB),
    isWorkspaceInspectionIntent(lower) || hasAffirmativeMatch(lower, FS_LIST_VERB),
    hasAffirmativeMatch(lower, FS_READ_VERB),
  ];
  return signals.filter(Boolean).length >= 2;
}

/**
 * Intenção de filesystem de uma etapa: a TAREFA (pedido original) é
 * autoritativa; o texto da etapa só é considerado quando a tarefa não deixa a
 * intenção clara. Evita que um rótulo gerado pelo Planner sobrescreva o que o
 * usuário realmente pediu.
 *
 * EXCEÇÃO: quando a tarefa afirma MAIS DE UMA operação ao mesmo tempo (ex.:
 * "liste X e leia Y" — um plano com uma etapa de list e outra de read), não
 * existe uma única intenção "autoritativa" para a tarefa inteira; usar a
 * primeira encontrada no texto combinado forçava TODAS as etapas — inclusive
 * a de leitura — a se comportarem como a PRIMEIRA operação mencionada. Nesse
 * caso a etapa (mais específica que a tarefa) decide.
 */
export function resolveFilesystemIntent(
  task: string,
  stepText = ""
): FilesystemIntent | null {
  if (stepText && hasMultipleFilesystemOperations(task)) {
    const stepIntent = detectFilesystemIntent(stepText);
    if (stepIntent) return stepIntent;
  }
  return detectFilesystemIntent(task) ?? detectFilesystemIntent(stepText);
}

/**
 * Etapas cuja natureza é READ-ONLY (observar/analisar/validar): nunca podem
 * executar uma operação de escrita, mesmo que o texto mencione esse verbo.
 */
export const READ_ONLY_CAPABILITIES: ReadonlySet<TaskCapability> = new Set<TaskCapability>([
  "analise",
  "validacao",
  "planejamento",
  "raciocinio",
  "conversa",
]);

/** `true` quando a capability da etapa é read-only por natureza. */
export function isReadOnlyCapability(capability: TaskCapability): boolean {
  return READ_ONLY_CAPABILITIES.has(capability);
}

/**
 * Remove `geracao_codigo` de um conjunto de capabilities quando a intenção de
 * filesystem da tarefa é CONFIRMADAMENTE read/list (nunca write).
 *
 * Por quê: `inferCapabilities` adiciona `geracao_codigo` por presença de
 * keyword (ex.: a palavra "scripts" — como em `package.json`'s `"scripts"` —
 * contém a substring "script", que é keyword de código). Numa tarefa de
 * INVESTIGAÇÃO/LEITURA explícita ("não altere nenhum arquivo"), isso fazia o
 * plano fallback incluir uma etapa "Implementar o código necessário" mesmo
 * sem nenhum pedido de escrita — violando a intenção READ_ONLY do usuário.
 *
 * Só filtra quando `filesystemIntent` é `"read"` ou `"list"`: se houver
 * qualquer verbo de escrita afirmativo em algum lugar do texto, o resolver já
 * teria retornado `"write"`, então esta função nunca remove uma geração de
 * código genuinamente pedida.
 */
export function stripCodeGenerationForReadOnlyIntent(
  capabilities: TaskCapability[],
  filesystemIntent: FilesystemIntent | null | undefined
): TaskCapability[] {
  if (filesystemIntent !== "read" && filesystemIntent !== "list") {
    return capabilities;
  }
  return capabilities.filter((cap) => cap !== "geracao_codigo");
}

/**
 * Infere as capacidades requeridas pela tarefa.
 * Base por categoria + acréscimos por keyword + regra de afinamento.
 */
export function inferCapabilities(
  category: TaskCategory,
  normalized: string,
  complexity: TaskComplexity
): TaskCapability[] {
  const caps = new Set<TaskCapability>();

  switch (category) {
    case "conversacao":
      caps.add("conversa");
      break;
    case "codigo":
      caps.add("geracao_codigo");
      caps.add("raciocinio");
      break;
    case "analise":
      caps.add("analise");
      caps.add("raciocinio");
      break;
    case "planejamento":
      caps.add("planejamento");
      caps.add("raciocinio");
      break;
    case "geral":
      caps.add("raciocinio");
      break;
  }

  if (hasKeyword(normalized, PLANNING_KEYWORDS).length > 0) {
    caps.add("planejamento");
  }
  if (hasKeyword(normalized, ANALYSIS_KEYWORDS).length > 0) {
    caps.add("analise");
  }
  if (hasKeyword(normalized, CODE_KEYWORDS).length > 0) {
    caps.add("geracao_codigo");
  }
  if (
    hasKeyword(normalized, VALIDATION_KEYWORDS).length > 0 ||
    (hasKeyword(normalized, CODE_KEYWORDS).length > 0 &&
      hasKeyword(normalized, new Set(["corrigir", "corrija", "correção", "correcao"])).length > 0)
  ) {
    caps.add("validacao");
  }

  // Regra de afinamento: planejamento sério exige análise prévia.
  if (complexity === "alta" && category === "planejamento") {
    caps.add("analise");
  }

  if (detectToolIntent(normalized) !== null) {
    caps.add("execucao_ferramenta");
  }

  return dedupInOrder([...caps]);
}

/** Pipeline principal: texto → `TaskProfile`. */
/**
 * Detecta um pedido explícito de parar logo após um conjunto fixo de
 * operações — ex.: "Depois pare imediatamente.", "then stop immediately",
 * "encerre a execução". Isso é diferente de uma tarefa read-only comum: o
 * usuário está limitando o ESCOPO DE TRABALHO, não só proibindo escrita.
 */
export function hasImmediateStopIntent(text: string): boolean {
  return /\b(pare|parar|paralise|encerr[ea]|termine|finalize)\b[^.!\n]{0,40}\bimediatamente\b|\bstop\b[^.!\n]{0,40}\bimmediately\b|\bencerre a execu[çc][ãa]o\b/i.test(
    text
  );
}

export function analyzeTask(text: string): TaskProfile {
  const normalized = text.trim();
  const charCount = normalized.length;
  const wordCount = wordsOf(normalized).length;

  const { complexity, hints: complexityHints } = classifyComplexity(
    normalized,
    wordCount,
    charCount
  );
  const { category, hints: categoryHints } = classifyCategory(normalized);
  const capabilities = inferCapabilities(category, normalized, complexity);
  const toolIntent = detectToolIntent(normalized);
  const filesystemIntent = toolIntent === "filesystem" ? detectFilesystemIntent(normalized) : null;
  const stopsImmediatelyAfterTools = hasImmediateStopIntent(normalized);

  return {
    text: normalized,
    complexity,
    category,
    capabilities,
    wordCount,
    charCount,
    toolIntent,
    filesystemIntent,
    stopsImmediatelyAfterTools,
    hints: [...complexityHints, ...categoryHints],
  };
}
