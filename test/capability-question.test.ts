import { describe, expect, it } from "vitest";

import {
  analyzeTask,
  classifyCategory,
  detectToolIntent,
  isCapabilityQuestion,
} from "../src/adaptive/taskAnalyzer.js";
import { decideStrategy } from "../src/adaptive/strategyEngine.js";

/**
 * Regressão: perguntas do tipo "você consegue criar um arquivo win.rar?"
 * antes eram tratadas como uma instrução de execução concreta (detectavam
 * `toolIntent: "compression"` com alvo "win.rar"), o loop autônomo tentava
 * chamar a tool de compressão sem parâmetros suficientes e estourava
 * `no_progress`. Este arquivo garante que perguntas de capacidade sejam
 * respondidas em linguagem natural (`conversacao` / `single_agent`), sem
 * disparar nenhuma tool.
 */
describe("isCapabilityQuestion", () => {
  it("reconhece perguntas de capacidade em português (consegue/sabe/pode/é possível)", () => {
    expect(isCapabilityQuestion("Você consegue criar um arquivo win.rar?")).toBe(true);
    expect(isCapabilityQuestion("consegue criar um arquivo win.rar?")).toBe(true);
    expect(isCapabilityQuestion("Você sabe compactar arquivos?")).toBe(true);
    expect(isCapabilityQuestion("é possível redimensionar uma foto?")).toBe(true);
    expect(isCapabilityQuestion("Dá para editar um PDF?")).toBe(true);
    expect(isCapabilityQuestion("Como funciona a compactação de arquivos?")).toBe(true);
  });

  it("não confunde uma pergunta de capacidade com um comando explícito de execução", () => {
    // Tem verbo de comando afirmativo com alvo concreto — deve ser executado,
    // não respondido como pergunta de capacidade.
    expect(isCapabilityQuestion("Crie o arquivo win.rar agora")).toBe(false);
    expect(isCapabilityQuestion("Compacte o arquivo teste.txt em teste.zip")).toBe(false);
  });

  it("retorna false para texto vazio ou sem padrão de capacidade", () => {
    expect(isCapabilityQuestion("")).toBe(false);
    expect(isCapabilityQuestion("Qual é a capital da França?")).toBe(false);
  });
});

describe("classifyCategory — perguntas de capacidade", () => {
  it("classifica pergunta de capacidade como conversacao", () => {
    const { category, hints } = classifyCategory("Você consegue criar um arquivo win.rar?");
    expect(category).toBe("conversacao");
    expect(hints.join(" ")).toContain("pergunta de capacidade");
  });
});

describe("detectToolIntent — perguntas de capacidade", () => {
  it("retorna null para pergunta de capacidade mesmo mencionando extensão de arquivo", () => {
    expect(detectToolIntent("Você consegue criar um arquivo win.rar?")).toBeNull();
    expect(detectToolIntent("sabe redimensionar uma foto?")).toBeNull();
  });

  it("continua detectando intenção real de ferramenta em comandos explícitos", () => {
    // ".zip" é tratado como intenção de DOCUMENTO (empacotamento), não de
    // compressão — só ".rar"/"descompactar"/"extrair" mapeiam para
    // "compression" (ver comentário em detectToolIntent).
    expect(detectToolIntent("Compacte o arquivo teste.txt em teste.zip")).toBe("document");
    expect(detectToolIntent("Descompacte o arquivo win.rar")).toBe("compression");
  });
});

describe("decideStrategy — perguntas de capacidade", () => {
  it("direciona pergunta de capacidade para single_agent (resposta direta em linguagem natural)", () => {
    const profile = analyzeTask("Você consegue criar um arquivo win.rar?");
    const decision = decideStrategy(profile);
    expect(decision.strategy).toBe("single_agent");
    expect(decision.reason.toLowerCase()).toContain("capacidade");
  });

  it("análise completa (analyzeTask) marca toolIntent como null para pergunta de capacidade", () => {
    const profile = analyzeTask("Você consegue criar um arquivo win.rar?");
    expect(profile.category).toBe("conversacao");
    expect(profile.toolIntent ?? null).toBeNull();
  });
});

describe("detectToolIntent — geração de imagem (sem tool de text-to-image)", () => {
  it("NÃO detecta intenção de tool para pedidos de gerar/criar imagem do zero", () => {
    // Regressão real: "crie uma imagem pra mim" entrava no loop autônomo,
    // que tentava chamar a tool de EDIÇÃO de imagem (não existe geração via
    // texto no ImageTool) com um inputPath inventado, falhava sempre e
    // desistia sem nunca explicar isso ao usuário.
    expect(detectToolIntent("crie uma imagem pra mim")).toBeNull();
    expect(detectToolIntent("gere uma foto de um gato")).toBeNull();
    expect(detectToolIntent("desenhe uma ilustração de uma praia")).toBeNull();
  });

  it("continua detectando intenção de tool ao EDITAR uma imagem existente", () => {
    expect(detectToolIntent("redimensione a foto foto.png para 800x600")).toBe("image");
    expect(detectToolIntent("aplique um filtro grayscale em imagem.jpg")).toBe("image");
    expect(detectToolIntent("edite a imagem que eu anexei")).toBe("image");
  });
});

describe("detectToolIntent — ler/inspecionar um .zip/.rar EXISTENTE (não é 'document')", () => {
  it("roteia leitura/inspeção de arquivo compactado para 'compression', não 'document'", () => {
    // Regressão real: "document" só CRIA zip/pdf/gráfico — não tem NENHUMA
    // ação de leitura. Pedidos como "leia o conteúdo do arquivo x.zip"
    // caíam no branch de "document" (que também bate em ".zip") e falhavam
    // sempre com "Não foi possível identificar a ação de documento".
    expect(detectToolIntent("Leia o conteúdo do arquivo axon-corrigido.zip")).toBe("compression");
    expect(detectToolIntent("me fale o que é esse arquivo.zip")).toBe("compression");
    expect(detectToolIntent("abra esse arquivo e inspecione o conteúdo dele, é um zip")).toBe("compression");
  });

  it("reconhece 'winrar' como sinônimo coloquial de arquivo compactado", () => {
    // "winrar" não bate no \b(rar)\b original (está colado em "win"), mas é
    // como as pessoas costumam se referir a qualquer arquivo compactado.
    expect(detectToolIntent("me fale oq e esse winrar")).toBe("compression");
  });

  it("continua roteando CRIAÇÃO de zip para 'document' normalmente", () => {
    expect(detectToolIntent("crie um arquivo zip com o relatorio.txt")).toBe("document");
  });
});

describe("isCapabilityQuestion — 'consegue X e me manda Y' é pedido de ação, não pergunta pura", () => {
  it("NÃO trata como pergunta de capacidade quando há cláusula de entrega ('e me manda/envia')", () => {
    // Regressão real: "consegue criar um projeto básico e me mandar por
    // win.rar?" era tratado como pergunta de capacidade pura (respondia só
    // em texto, nunca tentava criar nada) — mas a pessoa claramente queria
    // o entregável, não uma explicação sobre se é possível.
    expect(isCapabilityQuestion("consegue criar um projeto basico e me mandar por win.rar?")).toBe(false);
    expect(isCapabilityQuestion("você consegue me enviar o arquivo?")).toBe(false);
    expect(isCapabilityQuestion("pode criar isso e me mandar?")).toBe(false);
  });

  it("continua tratando como pergunta de capacidade genuína quando NÃO há pedido de entrega", () => {
    // Preserva o comportamento original para o caso que motivou a feature.
    expect(isCapabilityQuestion("Você consegue criar um arquivo win.rar?")).toBe(true);
    expect(isCapabilityQuestion("consegue criar uma imagem do sonic?")).toBe(true);
  });

  it("'consegue X e me manda Y' roteia para autonomous (tenta executar de verdade)", () => {
    const profile = analyzeTask("consegue criar um projeto basico e me mandar por win.rar?");
    const decision = decideStrategy(profile);
    expect(decision.strategy).toBe("autonomous");
    // "projeto" com verbo de criação vai para o caminho dedicado de
    // scaffold de projeto (múltiplos arquivos reais), não para "compression"
    // — ver projectScaffold.ts.
    expect(profile.toolIntent).toBe("project");
  });
});
