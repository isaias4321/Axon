// Axon — Client de Chat com o Agente de IA (Vanilla JS moderno).
// O backend gerencia internamente estratégias, planners, runtime e memória.
// O frontend mapeia exclusivamente eventos operacionais reais do SSE
// (analisando, ferramentas, validações e conclusão).

const STORAGE_KEYS = {
  apiKey: "axon.apiKey",
  baseUrl: "axon.baseUrl",
  currentSessionId: "axon.currentSessionId",
  sessions: "axon.sessions",
};

// Gerenciador de Sessões Leve no localStorage
function loadSessions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.sessions);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveSessions(sessions) {
  try {
    // Guarda no máximo as 30 sessões mais recentes para manter leve
    const trimmed = sessions.slice(0, 30);
    localStorage.setItem(STORAGE_KEYS.sessions, JSON.stringify(trimmed));
  } catch (e) {
    console.warn("Falha ao salvar sessões no localStorage", e);
  }
}

const state = {
  apiKey: localStorage.getItem(STORAGE_KEYS.apiKey) || "dev-key",
  baseUrl: localStorage.getItem(STORAGE_KEYS.baseUrl) || "",
  sessionId: localStorage.getItem(STORAGE_KEYS.currentSessionId) || crypto.randomUUID(),
  sessions: loadSessions(),
  isStreaming: false,
  abortController: null,
  // Anexos selecionados no composer, ainda não enviados como mensagem.
  // Cada item: { filename, size, status: "uploading"|"done"|"error", path, downloadUrl, error }
  attachments: [],
};

localStorage.setItem(STORAGE_KEYS.currentSessionId, state.sessionId);

// Referências aos elementos da DOM
const el = {
  sidebar: document.getElementById("sidebar"),
  sidebarBackdrop: document.getElementById("sidebar-backdrop"),
  mobileMenuBtn: document.getElementById("mobile-menu-btn"),
  sidebarCloseBtn: document.getElementById("sidebar-close-btn"),
  newChatBtn: document.getElementById("new-chat-btn"),
  sessionsList: document.getElementById("sessions-list"),
  sessionTitle: document.getElementById("session-title"),
  transcript: document.getElementById("transcript"),
  transcriptContainer: document.getElementById("transcript-container"),
  emptyState: document.getElementById("empty-state"),
  composer: document.getElementById("composer"),
  input: document.getElementById("composer-input"),
  sendBtn: document.getElementById("send-btn"),
  attachBtn: document.getElementById("attach-btn"),
  fileInput: document.getElementById("file-upload-input"),
  attachmentPreview: document.getElementById("attachment-preview"),
  healthIndicator: document.getElementById("health-indicator"),
  healthDot: document.getElementById("health-dot"),
  healthLabel: document.getElementById("health-label"),
  settingsBtn: document.getElementById("settings-btn"),
  settingsDialog: document.getElementById("settings-dialog"),
  settingsClose: document.getElementById("settings-close"),
  baseUrlInput: document.getElementById("base-url-input"),
  apiKeyInput: document.getElementById("api-key-input"),
  toggleKeyVisibility: document.getElementById("toggle-key-visibility"),
  connStatus: document.getElementById("conn-status"),
  settingsTestConn: document.getElementById("settings-test-conn"),
  settingsSave: document.getElementById("settings-save"),
  providersList: document.getElementById("providers-list"),
  providersRefresh: document.getElementById("providers-refresh"),
};

function apiUrl(path) {
  const base = state.baseUrl.trim().replace(/\/$/, "");
  return base + path;
}

// Sanitização de Entidades HTML
function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtMs(ms) {
  if (typeof ms !== "number" || ms == null || isNaN(ms)) return "—";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function scrollToBottom() {
  if (el.transcriptContainer) {
    el.transcriptContainer.scrollTop = el.transcriptContainer.scrollHeight;
  }
}

// ==========================================================================
// Renderizador Markdown Seguro & Sanitizado
// ==========================================================================

function renderMarkdown(src) {
  const lines = String(src == null ? "" : src).replace(/\r\n/g, "\n").split("\n");
  let html = "";
  let i = 0;
  let para = [];

  const flushPara = () => {
    if (para.length === 0) return;
    const text = para.join("\n");
    html += `<p>${inlineMarkdown(text)}</p>\n`;
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    // Bloco de código com ```
    const codeBlockMatch = line.match(/^```(\w*)\s*$/);
    if (codeBlockMatch) {
      flushPara();
      const lang = codeBlockMatch[1] || "code";
      const codeLines = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // consome o fechamento ```
      const rawCode = codeLines.join("\n");
      html += `
        <div class="codeblock">
          <div class="codeblock-head">
            <span>${esc(lang)}</span>
            <button type="button" class="copy-code-btn" data-code="${esc(rawCode)}">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              <span>Copiar</span>
            </button>
          </div>
          <pre><code>${esc(rawCode)}</code></pre>
        </div>
      `;
      continue;
    }

    // Títulos #, ##, ###, ####
    const headerMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headerMatch) {
      flushPara();
      const lvl = headerMatch[1].length;
      html += `<h${lvl}>${inlineMarkdown(headerMatch[2])}</h${lvl}>\n`;
      i++;
      continue;
    }

    // Listas não-ordenadas (- ou *)
    if (/^\s*[-*]\s+/.test(line)) {
      flushPara();
      html += "<ul>\n";
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const itemContent = lines[i].replace(/^\s*[-*]\s+/, "");
        html += `<li>${inlineMarkdown(itemContent)}</li>\n`;
        i++;
      }
      html += "</ul>\n";
      continue;
    }

    // Listas ordenadas (1. 2. etc.)
    if (/^\s*\d+\.\s+/.test(line)) {
      flushPara();
      html += "<ol>\n";
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const itemContent = lines[i].replace(/^\s*\d+\.\s+/, "");
        html += `<li>${inlineMarkdown(itemContent)}</li>\n`;
        i++;
      }
      html += "</ol>\n";
      continue;
    }

    // Citações >
    if (/^\s*>\s?/.test(line)) {
      flushPara();
      const quote = line.replace(/^\s*>\s?/, "");
      html += `<blockquote>${inlineMarkdown(quote)}</blockquote>\n`;
      i++;
      continue;
    }

    // Linha horizontal ---
    if (/^\s*---+\s*$/.test(line.trim())) {
      flushPara();
      html += "<hr>\n";
      i++;
      continue;
    }

    // Linhas vazias
    if (line.trim() === "") {
      flushPara();
    } else {
      para.push(line);
    }
    i++;
  }
  flushPara();
  return html;
}

// Extensões de arquivos que o agente costuma gerar e que devem virar um
// botão de download ao aparecer mencionadas em texto (ex.: "criei o
// arquivo relatorio.pdf" ou `teste.rar`). Propositalmente NÃO inclui
// extensões de código (.js, .ts, .py, .html...) para não confundir menções
// comuns como "Node.js" com um arquivo baixável.
const DOWNLOADABLE_FILE_EXT =
  "zip|rar|7z|tar\\.gz|tar|gz|pdf|docx?|xlsx?|pptx?|csv|tsv|txt|json|md|log|sql|xml|ya?ml|" +
  "png|jpe?g|gif|svg|webp|bmp|ico|mp3|wav|mp4|mov";
const FILE_PATH_RE = new RegExp(`/?(?:[\\w.-]+/)*[\\w][\\w.-]*\\.(?:${DOWNLOADABLE_FILE_EXT})`, "i");
const FILE_PATH_RE_GLOBAL = new RegExp(`(^|[\\s(])(${FILE_PATH_RE.source})\\b`, "gi");

function buildDownloadUrl(path) {
  return `/v1/files/download?path=${encodeURIComponent(path)}`;
}

function renderDownloadChip(path) {
  const filename = path.split("/").pop();
  return (
    `<a class="download-btn-link" href="${esc(buildDownloadUrl(path))}" download="${esc(filename)}" target="_blank" rel="noopener noreferrer">` +
    `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"/></svg>` +
    `<span>${esc(filename)}</span>` +
    `</a>`
  );
}

function inlineMarkdown(text) {
  // Tokens de HTML já processado (código, links, botões de download) que
  // não devem passar pela escapagem/pelas regras de negrito/itálico que
  // vêm depois. Usamos caracteres da área de uso privado do Unicode, que
  // não aparecem em texto normal nem são afetados por esc().
  const stash = [];
  const hold = (html) => {
    stash.push(html);
    return `\uE000${stash.length - 1}\uE001`;
  };

  let s = String(text == null ? "" : text);

  // Código inline — protegido antes de qualquer outra coisa. Se o
  // conteúdo do código for, ele mesmo, um caminho de arquivo baixável
  // (ex.: `relatorio.pdf`), vira um botão de download em vez de <code>.
  s = s.replace(/`([^`]+)`/g, (_, code) => {
    const trimmed = code.trim();
    if (new RegExp(`^${FILE_PATH_RE.source}$`, "i").test(trimmed)) {
      return hold(renderDownloadChip(trimmed));
    }
    return hold(`<code>${esc(code)}</code>`);
  });

  // Links markdown seguros (apenas http:// ou https://)
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi, (_, label, url) =>
    hold(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`)
  );

  // Caminhos de arquivo mencionados em texto puro (fora de código/links)
  // viram botões de download, ex.: "salvei em /app/teste.zip" ou "gerei o
  // win.rar".
  s = s.replace(FILE_PATH_RE_GLOBAL, (_, pre, path) => `${pre}${hold(renderDownloadChip(path))}`);

  // Escapa o restante do texto puro (os tokens \uE000N\uE001 não contêm
  // caracteres afetados por esc(), então sobrevivem intactos).
  s = esc(s);

  // Negrito ** ou __
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  // Itálico * ou _
  s = s.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_])_([^_]+)_(?!_)/g, "$1<em>$2</em>");

  // Restaura os HTML já processados por último, para que não sejam
  // reprocessados pelas regras acima.
  s = s.replace(/\uE000(\d+)\uE001/g, (_, idx) => stash[Number(idx)]);

  return s;
}

// ==========================================================================
// Renderização no Transcript
// ==========================================================================

function removeEmptyState() {
  if (el.emptyState && el.emptyState.parentNode) {
    el.emptyState.remove();
    el.emptyState = null;
  }
}

function renderUserMessage(text, attachments) {
  removeEmptyState();
  const wrap = document.createElement("div");
  wrap.className = "msg-wrapper user";

  const bubble = document.createElement("div");
  bubble.className = "bubble user-bubble";

  if (Array.isArray(attachments) && attachments.length > 0) {
    const filesRow = document.createElement("div");
    filesRow.className = "user-msg-attachments";
    for (const att of attachments) {
      const hasLink = Boolean(att.downloadUrl);
      const chip = document.createElement(hasLink ? "a" : "span");
      chip.className = "attachment-chip sent";
      if (hasLink) {
        chip.href = att.downloadUrl;
        chip.target = "_blank";
        chip.rel = "noopener noreferrer";
        chip.title = "Baixar/visualizar arquivo enviado";
      }
      chip.innerHTML = `
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
        <span class="attachment-chip-name">${esc(att.filename || "arquivo")}</span>
      `;
      filesRow.appendChild(chip);
    }
    bubble.appendChild(filesRow);
  }

  if (text) {
    const textEl = document.createElement("div");
    textEl.className = "user-msg-text";
    textEl.textContent = text;
    bubble.appendChild(textEl);
  }

  wrap.appendChild(bubble);
  el.transcript.appendChild(wrap);
  scrollToBottom();
  return wrap;
}

function renderAssistantMessage(content) {
  removeEmptyState();
  const wrap = document.createElement("div");
  wrap.className = "msg-wrapper assistant";
  
  const bubble = document.createElement("div");
  bubble.className = "bubble assistant-bubble";
  bubble.innerHTML = renderMarkdown(content);
  
  wrap.appendChild(bubble);
  el.transcript.appendChild(wrap);
  scrollToBottom();
  return wrap;
}

function renderErrorMessage(msg) {
  removeEmptyState();
  const wrap = document.createElement("div");
  wrap.className = "msg-wrapper error";
  
  const bubble = document.createElement("div");
  bubble.className = "bubble error-bubble";
  bubble.textContent = msg;
  
  wrap.appendChild(bubble);
  el.transcript.appendChild(wrap);
  scrollToBottom();
  return wrap;
}

// ==========================================================================
// Rastreamento Discreto de Atividade & Ferramentas (SSE Real)
// ==========================================================================

const PHASE_LABELS = {
  analise: "Analisando",
  decisao: "Planejando",
  planejamento: "Estruturando plano",
  execucao: "Executando",
  iteracao: "Executando",
  validacao: "Validando",
  orquestracao: "Orquestrando",
  sintese: "Sintetizando",
  cognitivo: "Roteando",
  fallback: "Buscando alternativa",
  tool: "Ferramenta",
  concluido: "Concluído",
  fim: "Concluído",
};

function createActivityTracker() {
  removeEmptyState();
  const container = document.createElement("div");
  container.className = "activity-trail";
  el.transcript.appendChild(container);
  scrollToBottom();

  let activeRow = null;

  const finishCurrentRow = () => {
    if (activeRow) {
      activeRow.classList.add("done");
    }
  };

  const addRow = (label, detail) => {
    finishCurrentRow();
    const row = document.createElement("div");
    row.className = "activity-row";
    row.innerHTML = `
      <span class="activity-check">✓</span>
      <span class="activity-dot-pulse"></span>
      <span class="activity-label">${esc(label)}</span>
      ${detail ? `<span class="activity-detail">${esc(detail)}</span>` : ""}
    `;
    container.appendChild(row);
    activeRow = row;
    scrollToBottom();
    return row;
  };

  return {
    onProgress: (ev) => {
      if (ev.phase === "tool" && ev.tool) {
        finishCurrentRow();
        renderToolCard(ev.tool, container);
        return;
      }
      if (ev.phase === "validacao") {
        finishCurrentRow();
        renderValidationItem(ev.detail, container, ev.passed);
        return;
      }
      if (ev.phase === "concluido" || ev.phase === "fim") {
        // Este evento é sempre seguido, no fim do stream, pela chamada a
        // done()/error() (ver handler de envio de mensagem) — que já lê
        // report.execution.executed e mostra o status real (✓ ou ✕) com
        // o motivo certo. Renderizar esta linha também duplicava o sinal
        // e podia contradizer o resultado final (✓ "Concluído" aqui,
        // seguido de ✕ "Não concluído" logo abaixo, para o MESMO evento).
        return;
      }
      const label = PHASE_LABELS[ev.phase] || ev.phase || "Processando";
      addRow(label, ev.detail || "");
    },
    done: () => {
      finishCurrentRow();
      const row = document.createElement("div");
      row.className = "activity-row done";
      row.innerHTML = `
        <span class="activity-check" style="display:inline-flex">✓</span>
        <span class="activity-label">Concluído</span>
      `;
      container.appendChild(row);
      scrollToBottom();
    },
    error: (msg) => {
      finishCurrentRow();
      const row = document.createElement("div");
      row.className = "activity-row done";
      row.style.color = "var(--error)";
      row.innerHTML = `
        <span style="color:var(--error)">✕</span>
        <span class="activity-label" style="color:var(--error)">${esc(msg)}</span>
      `;
      container.appendChild(row);
      scrollToBottom();
    },
    container,
  };
}

// Cartão de Execução de Ferramenta Discreto e Expansível
function renderToolCard(tool, parentEl) {
  const card = document.createElement("div");
  const isOk = tool.status === "ok";
  card.className = `tool-card ${isOk ? "" : "error"}`;

  const toolName = tool.name || tool.action || "tool";
  const duration = tool.durationMs != null ? fmtMs(tool.durationMs) : "";

  card.innerHTML = `
    <button type="button" class="tool-header" aria-expanded="false">
      <span class="tool-status-icon ${isOk ? "ok" : "err"}">${isOk ? "✓" : "✕"}</span>
      <span class="tool-title">${esc(toolName)}</span>
      ${duration ? `<span class="tool-meta">${esc(duration)}</span>` : ""}
      <span class="tool-chevron">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg>
      </span>
    </button>
    <div class="tool-body">
      <div class="tool-dl">
        <div class="tool-dl-row">
          <span class="tool-dl-dt">Ação</span>
          <span class="tool-dl-dd">${esc(tool.action || toolName)}</span>
        </div>
        <div class="tool-dl-row">
          <span class="tool-dl-dt">Status</span>
          <span class="tool-dl-dd ${isOk ? "verified" : "error-text"}">${isOk ? "Executado com sucesso" : "Falha na execução"}</span>
        </div>
        ${tool.summary ? `
          <div class="tool-dl-row">
            <span class="tool-dl-dt">Resultado</span>
            <span class="tool-dl-dd">${esc(tool.summary)}</span>
          </div>
        ` : ""}
        ${tool.error ? `
          <div class="tool-dl-row">
            <span class="tool-dl-dt">Erro</span>
            <span class="tool-dl-dd error-text">${esc(tool.error)}</span>
          </div>
        ` : ""}
      </div>
    </div>
  `;

  const headerBtn = card.querySelector(".tool-header");
  headerBtn.addEventListener("click", () => {
    const isExpanded = card.classList.toggle("expanded");
    headerBtn.setAttribute("aria-expanded", String(isExpanded));
  });

  (parentEl || el.transcript).appendChild(card);
  scrollToBottom();
  return card;
}

function renderValidationItem(detail, parentEl, passed) {
  const row = document.createElement("div");
  // Usa o campo explícito `passed` (vindo do backend) quando disponível —
  // NÃO adivinha sucesso/falha procurando "não"/"falh" dentro do texto:
  // a descrição da própria etapa sendo validada pode legitimamente conter
  // essas palavras (ex.: "...funções que ainda não possuem documentação"),
  // fazendo uma validação bem-sucedida ser exibida como reprovada.
  const isErr =
    typeof passed === "boolean"
      ? !passed
      : Boolean(detail && (detail.toLowerCase().includes("não passou") || detail.toLowerCase().includes("falhou")));
  row.className = `validation-row ${isErr ? "err" : "ok"}`;
  row.innerHTML = `
    <span>${isErr ? "✕" : "✓"}</span>
    <span>${esc(detail || "Validação realizada")}</span>
  `;
  (parentEl || el.transcript).appendChild(row);
  scrollToBottom();
  return row;
}

// ==========================================================================
// Consumo da API & SSE Streaming
// ==========================================================================

async function streamAgentRun(body, onProgress, signal) {
  let res;
  try {
    res = await fetch(apiUrl("/v1/run"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": state.apiKey,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error("Execução interrompida pelo usuário.");
    }
    throw new Error("Conexão com a API falhou. Verifique se o servidor está ativo.");
  }

  const contentType = res.headers.get("content-type") || "";
  
  if (!contentType.includes("text/event-stream")) {
    let data = null;
    try { data = await res.json(); } catch {}
    if (res.status === 401) throw new Error("Chave de API inválida (x-api-key).");
    if (!res.ok) throw new Error((data && (data.message || data.error)) || `Erro HTTP ${res.status}`);
    return data;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sepIndex;
      while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex + 2);

        const eventMatch = rawEvent.match(/^event:\s*(\w+)\s*$/m);
        const dataMatch = rawEvent.match(/^data:\s*(.*)$/m);
        if (!eventMatch || !dataMatch) continue;

        let payload;
        try {
          payload = JSON.parse(dataMatch[1]);
        } catch {
          continue;
        }

        const eventName = eventMatch[1];
        if (eventName === "progress") {
          onProgress(payload);
        } else if (eventName === "done") {
          return payload;
        } else if (eventName === "error") {
          throw new Error(payload.message || payload.error || "Erro durante a execução.");
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  throw new Error("A conexão com o servidor encerrou antes da conclusão da tarefa.");
}

async function apiFetch(path, options = {}) {
  let res;
  try {
    res = await fetch(apiUrl(path), {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": state.apiKey,
        ...(options.headers || {}),
      },
    });
  } catch {
    throw new Error("Conexão com a API falhou.");
  }
  let body = null;
  try { body = await res.json(); } catch {}
  if (res.status === 401) throw new Error("Chave de API inválida (x-api-key).");
  if (!res.ok) throw new Error((body && (body.message || body.error)) || `HTTP ${res.status}`);
  return body;
}

function friendlyError(err) {
  const msg = err && err.message ? String(err.message) : String(err);
  if (/\b401\b/.test(msg)) return "Falha de autenticação (401) — verifique a x-api-key.";
  if (/\b429\b/.test(msg)) return "Limite de requisições excedido pelo provedor (429).";
  if (/\b503\b/.test(msg)) return "Provedor temporariamente indisponível (503).";
  if (/\b502\b/.test(msg)) return "Erro no provedor upstream (502).";
  if (/\b504\b/.test(msg)) return "Tempo limite de execução excedido (504).";
  return msg || "Ocorreu um erro na requisição.";
}

function formatReportResponse(report) {
  if (!report) return "(Nenhum relatório recebido)";
  const execution = report.execution || {};
  // IMPORTANTE: não exigir `execution.executed === true` aqui. Quando o loop
  // autônomo desiste (no_progress/failure), `executed` corretamente vira
  // `false` — mas o backend ainda sintetiza uma explicação em linguagem
  // natural em `execution.content` (ver synthesizeFallbackAnswer em
  // src/adaptive/autonomous.ts) contando o que realmente aconteceu e
  // sugerindo uma alternativa. Exigir `executed` aqui descartava essa
  // explicação e mostrava só o banner genérico "⚠️ Encerramento com status:
  // no_progress" — sem dizer ao usuário POR QUÊ.
  if (execution.content) {
    return String(execution.content);
  }
  if (execution.error) {
    return `⚠️ ${execution.error}`;
  }
  if (report.cognitive && report.cognitive.summary) {
    return String(report.cognitive.summary);
  }
  if (report.finalResult) {
    return String(report.finalResult);
  }
  return "✓ Tarefa processada pelo agente.";
}

// ==========================================================================
// Anexos de Arquivo (botão + / upload / preview)
// ==========================================================================

function formatBytes(bytes) {
  if (typeof bytes !== "number" || isNaN(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderAttachmentPreview() {
  if (!el.attachmentPreview) return;
  el.attachmentPreview.innerHTML = "";

  state.attachments.forEach((att, idx) => {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";
    if (att.status === "uploading") chip.classList.add("uploading");
    if (att.status === "error") chip.classList.add("error");

    let label;
    if (att.status === "uploading") {
      label = `Enviando ${att.filename}…`;
    } else if (att.status === "error") {
      label = `Falha: ${att.filename}`;
    } else {
      label = att.size != null ? `${att.filename} (${formatBytes(att.size)})` : att.filename;
    }

    chip.innerHTML = `
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
      <span class="attachment-chip-name" title="${esc(att.error || "")}">${esc(label)}</span>
      <button type="button" class="remove-file-btn" data-idx="${idx}" aria-label="Remover anexo" title="Remover anexo">
        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    `;
    el.attachmentPreview.appendChild(chip);
  });
}

function removeAttachment(idx) {
  state.attachments.splice(idx, 1);
  renderAttachmentPreview();
}

async function uploadSingleFile(file) {
  const att = {
    filename: file.name,
    size: file.size,
    status: "uploading",
    path: null,
    downloadUrl: null,
    error: null,
  };
  state.attachments.push(att);
  renderAttachmentPreview();

  const formData = new FormData();
  // sessionId ANTES do arquivo: @fastify/multipart processa o form em
  // stream, então um campo de texto que vem DEPOIS do arquivo no corpo da
  // requisição pode não estar disponível ainda quando o backend lê
  // `data.fields` logo após terminar de ler o arquivo. Mandando primeiro,
  // o backend consegue associar o upload a esta sessão (ver artifacts.js) —
  // sem isso, "esse arquivo que mandei" nunca teria como ser resolvido.
  formData.append("sessionId", state.sessionId);
  formData.append("file", file, file.name);

  try {
    const res = await fetch(apiUrl("/v1/files/upload"), {
      method: "POST",
      headers: { "x-api-key": state.apiKey },
      body: formData,
    });

    let data = null;
    try {
      data = await res.json();
    } catch {
      // resposta sem corpo JSON válido — tratado abaixo pelo !res.ok
    }

    if (!res.ok || !data || data.success !== true) {
      throw new Error((data && (data.error || data.message)) || `Falha no upload (HTTP ${res.status})`);
    }

    att.status = "done";
    att.filename = data.filename || att.filename;
    att.path = data.path;
    att.size = typeof data.size === "number" ? data.size : att.size;
    att.downloadUrl = data.downloadUrl || buildDownloadUrl(data.path || att.filename);
  } catch (err) {
    att.status = "error";
    att.error = err && err.message ? err.message : String(err);
  }

  renderAttachmentPreview();
}

function handleFilesSelected(fileList) {
  Array.from(fileList || []).forEach((file) => uploadSingleFile(file));
}

if (el.attachBtn && el.fileInput) {
  el.attachBtn.addEventListener("click", () => el.fileInput.click());
  el.fileInput.addEventListener("change", () => {
    handleFilesSelected(el.fileInput.files);
    // Permite selecionar o(s) mesmo(s) arquivo(s) novamente em seguida.
    el.fileInput.value = "";
  });
}

if (el.attachmentPreview) {
  el.attachmentPreview.addEventListener("click", (e) => {
    const btn = e.target.closest(".remove-file-btn");
    if (btn) removeAttachment(Number(btn.dataset.idx));
  });
}

// Suporte a arraste-e-solte de arquivos direto sobre o composer.
if (el.composer) {
  ["dragover", "dragenter"].forEach((evtName) => {
    el.composer.addEventListener(evtName, (e) => {
      e.preventDefault();
      el.composer.classList.add("drag-over");
    });
  });
  ["dragleave", "drop"].forEach((evtName) => {
    el.composer.addEventListener(evtName, (e) => {
      e.preventDefault();
      el.composer.classList.remove("drag-over");
    });
  });
  el.composer.addEventListener("drop", (e) => {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      handleFilesSelected(e.dataTransfer.files);
    }
  });
}

// ==========================================================================
// Envio de Mensagens & Controle do Composer
// ==========================================================================

function updateComposerState(isStreaming) {
  state.isStreaming = isStreaming;
  if (isStreaming) {
    el.sendBtn.classList.add("stop-btn");
    el.sendBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
        <rect x="6" y="6" width="12" height="12" rx="2" />
      </svg>
    `;
    el.sendBtn.title = "Parar execução";
    el.sendBtn.ariaLabel = "Parar execução";
    el.sendBtn.disabled = false;
  } else {
    el.sendBtn.classList.remove("stop-btn");
    el.sendBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M5 12h14M13 6l6 6-6 6" />
      </svg>
    `;
    el.sendBtn.title = "Enviar (Enter)";
    el.sendBtn.ariaLabel = "Enviar";
    el.sendBtn.disabled = false;
  }
}

function buildTaskWithAttachments(text, attachments) {
  if (!attachments || attachments.length === 0) return text;

  // Importante: manter isso extremamente simples e sem ambiguidade. Uma
  // versão anterior incluía "(nome original: X, 2.2MB)" ao lado do caminho
  // — modelos pequenos (ex.: groq oss-20b/120b) chegaram a interpretar
  // erroneamente o número do tamanho ("2.2" de "2.2MB") como se fosse parte
  // do caminho do arquivo e tentaram usar "/app/2.2" como source path.
  // Agora é só o caminho entre aspas, sem nenhum outro número/texto perto.
  const paths = attachments.map((a) => a.path || a.filename).filter(Boolean);
  if (paths.length === 0) return text;

  const header =
    paths.length === 1
      ? `O usuário anexou um arquivo, já salvo no workspace neste caminho exato: "${paths[0]}". Use esse caminho literal ao chamar as tools de arquivo — não invente nem abrevie o nome.`
      : `O usuário anexou ${paths.length} arquivos, já salvos no workspace nestes caminhos exatos:\n${paths.map((p) => `"${p}"`).join("\n")}\nUse esses caminhos literais ao chamar as tools de arquivo — não invente nem abrevie os nomes.`;

  return text ? `${text}\n\n${header}` : header;
}

async function sendMessage(text, attachments = []) {
  if ((!text && attachments.length === 0) || state.isStreaming) return;

  const titleSource = text || (attachments[0] && attachments[0].filename) || "Arquivo enviado";

  // Garante que a sessão atual existe no histórico
  let currentSession = state.sessions.find((s) => s.id === state.sessionId);
  if (!currentSession) {
    const title = titleSource.length > 38 ? titleSource.slice(0, 38).trim() + "…" : titleSource;
    currentSession = {
      id: state.sessionId,
      title,
      createdAt: Date.now(),
      messages: [],
    };
    state.sessions.unshift(currentSession);
    saveSessions(state.sessions);
    renderSessionsList();
    if (el.sessionTitle) el.sessionTitle.textContent = title;
  }

  // Registra mensagem do usuário (com metadados dos anexos, se houver)
  currentSession.messages.push({ role: "user", content: text, attachments });
  saveSessions(state.sessions);

  renderUserMessage(text, attachments);
  const tracker = createActivityTracker();

  state.abortController = new AbortController();
  updateComposerState(true);

  try {
    const task = buildTaskWithAttachments(text, attachments);
    const report = await streamAgentRun(
      {
        task,
        sessionId: state.sessionId,
        stream: true,
      },
      (ev) => tracker.onProgress(ev),
      state.abortController.signal
    );

    // O stream pode terminar sem lançar exceção mesmo quando o agente NÃO
    // concluiu a tarefa (ex.: loop autônomo parou por max_iterations/
    // no_progress) — nesse caso `report.execution.executed` é `false` e
    // `report.execution.error` traz o motivo. Antes, a trilha de atividade
    // só olhava "o fetch não lançou" para decidir entre ✓/✕, então sempre
    // mostrava "✓ Concluído" mesmo quando o agente desistiu sem terminar.
    // Resposta do Cognitive Router (F9) não tem `execution` — usa
    // `allSuccessful` como sinal equivalente nesse caso.
    let executed;
    let failureReason = "o agente não concluiu a tarefa";
    if (report && report.cognitive) {
      executed = Boolean(report.cognitive.allSuccessful);
      if (!executed && Array.isArray(report.cognitive.errors) && report.cognitive.errors.length) {
        failureReason = report.cognitive.errors.join("; ");
      }
    } else {
      executed = Boolean(report && report.execution && report.execution.executed);
      if (!executed && report && report.execution && report.execution.error) {
        failureReason = report.execution.error;
      }
    }
    if (executed) {
      tracker.done();
    } else {
      tracker.error(`Não concluído — ${failureReason}`);
    }
    const assistantReply = formatReportResponse(report);
    renderAssistantMessage(assistantReply);

    // Salva resposta na sessão
    currentSession.messages.push({ role: "assistant", content: assistantReply });
    saveSessions(state.sessions);
  } catch (err) {
    const errorText = friendlyError(err);
    tracker.error(errorText);
    renderErrorMessage(errorText);
    currentSession.messages.push({ role: "error", content: errorText });
    saveSessions(state.sessions);
  } finally {
    state.abortController = null;
    updateComposerState(false);
  }
}

// ==========================================================================
// Gerenciamento de Sessões / Histórico
// ==========================================================================

function renderSessionsList() {
  if (!el.sessionsList) return;
  el.sessionsList.innerHTML = "";

  if (state.sessions.length === 0) {
    const empty = document.createElement("div");
    empty.style.fontSize = "12px";
    empty.style.color = "var(--text-faint)";
    empty.style.padding = "8px 10px";
    empty.textContent = "Nenhuma conversa recente";
    el.sessionsList.appendChild(empty);
    return;
  }

  for (const session of state.sessions) {
    const item = document.createElement("div");
    item.className = `session-item ${session.id === state.sessionId ? "active" : ""}`;
    item.setAttribute("role", "button");
    item.tabIndex = 0;
    
    item.innerHTML = `
      <span class="session-item-text" title="${esc(session.title)}">${esc(session.title)}</span>
      <button type="button" class="session-delete-btn" title="Excluir conversa" aria-label="Excluir conversa">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    `;

    // Alternar sessão ao clicar
    item.addEventListener("click", (e) => {
      if (e.target.closest(".session-delete-btn")) return;
      switchSession(session.id);
    });

    // Deletar sessão
    const delBtn = item.querySelector(".session-delete-btn");
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteSession(session.id);
    });

    el.sessionsList.appendChild(item);
  }
}

function startNewChat() {
  state.sessionId = crypto.randomUUID();
  localStorage.setItem(STORAGE_KEYS.currentSessionId, state.sessionId);
  
  if (el.sessionTitle) el.sessionTitle.textContent = "Nova conversa";
  el.transcript.innerHTML = `
    <div class="empty-state" id="empty-state">
      <div class="empty-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="5" cy="12" r="2.5" fill="currentColor" stroke="none" />
          <circle cx="19" cy="5" r="2" fill="currentColor" stroke="none" />
          <circle cx="19" cy="19" r="2" fill="currentColor" stroke="none" />
          <path d="M7.5 12H13.5 M6 10.5 L13 6 M10.5 13.5 L17.5 18" stroke="currentColor" />
        </svg>
      </div>
      <h1 class="empty-title">Como o Axon pode agir por você?</h1>
      <p class="empty-sub">
        Peça uma análise, criação de arquivos ou comandos reais no sistema. O Axon escolhe as ferramentas e valida os resultados.
      </p>
      <div class="suggestions-grid">
        <button type="button" class="suggestion-card" data-prompt="Crie um arquivo chamado hello.txt contendo Hello from Axon.">
          <span class="suggestion-title">Criar arquivo</span>
          <span class="suggestion-desc">Crie um arquivo hello.txt contendo Hello from Axon</span>
        </button>
        <button type="button" class="suggestion-card" data-prompt="Verifique o status de saúde dos provedores de LLM configurados.">
          <span class="suggestion-title">Status dos provedores</span>
          <span class="suggestion-desc">Verifique a conexão dos modelos de IA</span>
        </button>
        <button type="button" class="suggestion-card" data-prompt="Liste os arquivos do workspace e resuma a estrutura.">
          <span class="suggestion-title">Explorar workspace</span>
          <span class="suggestion-desc">Liste os arquivos e resuma a estrutura</span>
        </button>
      </div>
    </div>
  `;
  el.emptyState = document.getElementById("empty-state");
  renderSessionsList();
  closeSidebarOnMobile();
  el.input.focus();
}

function switchSession(sessionId) {
  const session = state.sessions.find((s) => s.id === sessionId);
  if (!session) return;

  state.sessionId = session.id;
  localStorage.setItem(STORAGE_KEYS.currentSessionId, state.sessionId);

  if (el.sessionTitle) el.sessionTitle.textContent = session.title;
  el.transcript.innerHTML = "";
  el.emptyState = null;

  if (session.messages && session.messages.length > 0) {
    for (const m of session.messages) {
      if (m.role === "user") {
        renderUserMessage(m.content, m.attachments);
      } else if (m.role === "error") {
        renderErrorMessage(m.content);
      } else {
        renderAssistantMessage(m.content);
      }
    }
  } else {
    startNewChat();
  }

  renderSessionsList();
  closeSidebarOnMobile();
}

function deleteSession(sessionId) {
  state.sessions = state.sessions.filter((s) => s.id !== sessionId);
  saveSessions(state.sessions);

  if (state.sessionId === sessionId) {
    if (state.sessions.length > 0) {
      switchSession(state.sessions[0].id);
    } else {
      startNewChat();
    }
  } else {
    renderSessionsList();
  }
}

function closeSidebarOnMobile() {
  if (el.sidebar) el.sidebar.classList.remove("open");
  if (el.sidebarBackdrop) el.sidebarBackdrop.classList.remove("active");
}

function openSidebarOnMobile() {
  if (el.sidebar) el.sidebar.classList.add("open");
  if (el.sidebarBackdrop) el.sidebarBackdrop.classList.add("active");
}

// ==========================================================================
// Health & Provedores
// ==========================================================================

async function checkHealth() {
  try {
    const res = await fetch(apiUrl("/health"));
    if (res.ok) {
      el.healthDot.className = "health-dot ok";
      el.healthLabel.textContent = "online";
    } else {
      throw new Error("unhealthy");
    }
  } catch {
    el.healthDot.className = "health-dot down";
    el.healthLabel.textContent = "offline";
  }
}

async function testConnection() {
  el.connStatus.textContent = "testando…";
  el.connStatus.className = "conn-status";
  try {
    const res = await fetch(apiUrl("/health"));
    if (res.ok) {
      el.connStatus.textContent = "API conectada";
      el.connStatus.className = "conn-status ok";
    } else {
      el.connStatus.textContent = "API offline (verifique a URL)";
      el.connStatus.className = "conn-status err";
    }
  } catch {
    el.connStatus.textContent = "API offline (falha de rede)";
    el.connStatus.className = "conn-status err";
  }
}

async function loadProviders() {
  if (!el.providersList) return;
  el.providersList.innerHTML = '<div class="providers-loading">Carregando provedores…</div>';

  try {
    const data = await apiFetch("/v1/providers/health");
    renderProvidersList((data && data.providers) || []);
  } catch (err) {
    el.providersList.innerHTML = `
      <div class="provider-error-msg">
        Falha ao buscar provedores: ${esc(friendlyError(err))}
      </div>
    `;
  }
}

function renderProvidersList(providers) {
  if (!el.providersList) return;
  el.providersList.innerHTML = "";

  if (providers.length === 0) {
    el.providersList.innerHTML = '<div class="providers-loading">Nenhum provedor encontrado.</div>';
    return;
  }

  for (const p of providers) {
    const card = document.createElement("div");
    card.className = "provider-card";
    card.dataset.provider = p.provider;

    const isConnected = p.status === "connected" || (p.configured && p.healthy);
    const isError = p.status === "error" || (p.configured && !p.healthy);
    const statusClass = isConnected ? "connected" : isError ? "error" : "not_configured";
    const statusLabel = isConnected ? "Connected" : isError ? "Error" : "Not configured";

    const latencyText = p.latencyMs != null ? fmtMs(p.latencyMs) : "";
    const modelsList = p.models || [];

    card.innerHTML = `
      <div class="provider-card-main">
        <div class="provider-info">
          <span class="provider-name">${esc(p.provider)}</span>
          <span class="provider-status-badge ${statusClass}">
            <span class="badge-dot"></span>
            <span>${esc(statusLabel)}</span>
          </span>
          ${latencyText ? `<span class="provider-latency">${esc(latencyText)}</span>` : ""}
        </div>
        <button
          type="button"
          class="provider-test-btn"
          data-provider="${esc(p.provider)}"
          ${p.configured ? "" : "disabled"}
        >
          ${p.configured ? "Testar" : "sem chave"}
        </button>
      </div>

      ${modelsList.length > 0 ? `
        <div class="provider-models-row">
          ${modelsList.map((m) => `<span class="model-pill">${esc(m)}</span>`).join("")}
        </div>
      ` : ""}

      ${p.error ? `
        <div class="provider-error-msg">
          ${esc(String(p.error))}
        </div>
      ` : ""}
    `;

    el.providersList.appendChild(card);
  }
}

async function testProvider(name) {
  const card = el.providersList.querySelector(`.provider-card[data-provider="${name}"]`);
  const btn = card ? card.querySelector(".provider-test-btn") : null;
  if (btn) {
    btn.classList.add("testing");
    btn.textContent = "testando…";
    btn.disabled = true;
  }

  try {
    // Tenta POST /v1/providers/:name/test primeiro; se indisponível, GET /v1/providers/health?provider=:name
    let result;
    try {
      result = await apiFetch(`/v1/providers/${encodeURIComponent(name)}/test`, { method: "POST" });
    } catch {
      const data = await apiFetch(`/v1/providers/health?provider=${encodeURIComponent(name)}`);
      result = (data && data.providers && data.providers[0]) || null;
    }

    if (result) {
      // Recarrega todos os provedores para manter a visão sincronizada
      await loadProviders();
    }
  } catch (err) {
    if (card) {
      let errBox = card.querySelector(".provider-error-msg");
      if (!errBox) {
        errBox = document.createElement("div");
        errBox.className = "provider-error-msg";
        card.appendChild(errBox);
      }
      errBox.textContent = friendlyError(err);
      if (btn) {
        btn.classList.remove("testing");
        btn.textContent = "Testar";
        btn.disabled = false;
      }
    }
  }
}

// ==========================================================================
// Modal de Configurações
// ==========================================================================

function openSettings() {
  el.baseUrlInput.value = state.baseUrl;
  el.apiKeyInput.value = state.apiKey;
  el.connStatus.textContent = "não testado";
  el.connStatus.className = "conn-status";

  if (typeof el.settingsDialog.showModal === "function") {
    el.settingsDialog.showModal();
  } else {
    el.settingsDialog.setAttribute("open", "");
  }

  loadProviders();
}

function closeSettings() {
  if (typeof el.settingsDialog.close === "function") {
    el.settingsDialog.close();
  } else {
    el.settingsDialog.removeAttribute("open");
  }
}

function saveSettings() {
  state.baseUrl = el.baseUrlInput.value.trim();
  state.apiKey = el.apiKeyInput.value.trim() || "dev-key";
  localStorage.setItem(STORAGE_KEYS.baseUrl, state.baseUrl);
  localStorage.setItem(STORAGE_KEYS.apiKey, state.apiKey);
  checkHealth();
  closeSettings();
}

// ==========================================================================
// Event Listeners
// ==========================================================================

// Composer Form Submit & Stop Trigger
el.composer.addEventListener("submit", (e) => {
  e.preventDefault();
  if (state.isStreaming) {
    if (state.abortController) {
      state.abortController.abort();
    }
    return;
  }

  const text = el.input.value.trim();
  const stillUploading = state.attachments.some((a) => a.status === "uploading");
  if (stillUploading) return; // aguarda os uploads em andamento terminarem

  const readyAttachments = state.attachments.filter((a) => a.status === "done");
  if (!text && readyAttachments.length === 0) return;

  el.input.value = "";
  el.input.style.height = "auto";
  sendMessage(text, readyAttachments);

  state.attachments = [];
  renderAttachmentPreview();
});

// Auto-resize textarea & Teclas Enter / Shift+Enter
el.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    el.composer.requestSubmit();
  }
});

el.input.addEventListener("input", () => {
  el.input.style.height = "auto";
  el.input.style.height = `${Math.min(el.input.scrollHeight, 180)}px`;
});

// Botão de Nova Conversa
el.newChatBtn.addEventListener("click", startNewChat);

// Sidebar Mobile Toggle
if (el.mobileMenuBtn) el.mobileMenuBtn.addEventListener("click", openSidebarOnMobile);
if (el.sidebarCloseBtn) el.sidebarCloseBtn.addEventListener("click", closeSidebarOnMobile);
if (el.sidebarBackdrop) el.sidebarBackdrop.addEventListener("click", closeSidebarOnMobile);

// Settings
el.settingsBtn.addEventListener("click", openSettings);
el.settingsClose.addEventListener("click", closeSettings);
el.settingsSave.addEventListener("click", saveSettings);
el.settingsTestConn.addEventListener("click", testConnection);
el.providersRefresh.addEventListener("click", loadProviders);

// Provider Test Delegation
el.providersList.addEventListener("click", (e) => {
  const btn = e.target.closest(".provider-test-btn");
  if (btn && btn.dataset.provider && !btn.disabled) {
    testProvider(btn.dataset.provider);
  }
});

// Toggle Visibilidade da Chave de API
if (el.toggleKeyVisibility) {
  el.toggleKeyVisibility.addEventListener("click", () => {
    const isPassword = el.apiKeyInput.type === "password";
    el.apiKeyInput.type = isPassword ? "text" : "password";
  });
}

// Fechar modal ao clicar no backdrop ou ESC
el.settingsDialog.addEventListener("click", (e) => {
  const box = el.settingsDialog.querySelector(".settings-box");
  if (box && !box.contains(e.target)) {
    closeSettings();
  }
});

// Botão de Cópia em Blocos de Código
document.addEventListener("click", async (e) => {
  const btn = e.target.closest(".copy-code-btn");
  if (btn) {
    const code = btn.dataset.code || "";
    try {
      await navigator.clipboard.writeText(code);
      const span = btn.querySelector("span");
      if (span) span.textContent = "Copiado!";
      setTimeout(() => {
        if (span) span.textContent = "Copiar";
      }, 2000);
    } catch {
      // Fallback
    }
  }

  // Sugestões do Empty State
  const suggestion = e.target.closest(".suggestion-card");
  if (suggestion && suggestion.dataset.prompt) {
    const prompt = suggestion.dataset.prompt;
    el.input.value = prompt;
    el.input.focus();
    el.composer.requestSubmit();
  }
});

// ==========================================================================
// Inicialização
// ==========================================================================

(function init() {
  renderSessionsList();
  
  // Se existir uma sessão ativa com mensagens, renderiza-a
  const activeSession = state.sessions.find((s) => s.id === state.sessionId);
  if (activeSession && activeSession.messages && activeSession.messages.length > 0) {
    switchSession(activeSession.id);
  }

  checkHealth();
  setInterval(checkHealth, 30000);
})();
