# 🧠 Axon — AI Agent Runtime com Cognitive Cells

[![CI](https://github.com/isaias4321/axon/actions/workflows/ci.yml/badge.svg)](https://github.com/isaias4321/axon/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/Node.js-22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Fastify](https://img.shields.io/badge/Fastify-5-000000?logo=fastify&logoColor=white)](https://fastify.dev/)
[![Tests](https://img.shields.io/badge/tests-544%20passing-2ea44f)](#-rodando-os-testes)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

*[English version](README.md)*

Este projeto começou como um **gateway unificado para múltiplos provedores
de LLM** (OpenAI, Anthropic, Google Gemini e Groq) e evoluiu para um
**AI Agent Runtime**: um sistema que analisa uma tarefa em linguagem
natural, decide sozinho a melhor estratégia de execução (resposta direta,
orquestração multiagente ou loop autônomo), roteia para o modelo mais
adequado, executa com ferramentas reais (grep, filesystem, shell, HTTP),
valida o próprio resultado, aprende com o feedback de execuções passadas e,
quando o intent é conhecido, delega para células cognitivas especializadas
(debug, planejamento, revisão de código, recuperação de falhas).

> Não é um wrapper de chat. É a camada de engenharia — roteamento,
> resiliência, memória, avaliação, autonomia — que faz a diferença entre
> "chamar uma API de LLM" e operar um agente de IA em produção.

## 🖼️ Demo

A interface de chat, rodando localmente:

<!-- TODO: adicione um print real da UI em docs/chat-ui.png antes de publicar
     (rode `npm run dev`, abra http://localhost:3000, tire o print) e troque
     a linha abaixo por:
     ![Interface de chat do Axon, mostrando uma conversa com o agente e o trace de execução na lateral](docs/chat-ui.png)
-->

Navegação pela documentação interativa (Swagger UI):

<video src="docs/demo.mp4" controls width="700">
  Seu navegador não suporta vídeo embutido — veja o arquivo em
  <a href="docs/demo.mp4">docs/demo.mp4</a>.
</video>

![Swagger UI com os endpoints do gateway](docs/swagger-overview.png)

Rodando dentro do próprio Docker (`docker compose up --build`), com o
`HEALTHCHECK` batendo automaticamente em `/health` a cada 30s:

<video src="docs/docker-demo.mp4" controls width="700">
  Seu navegador não suporta vídeo embutido — veja o arquivo em
  <a href="docs/docker-demo.mp4">docs/docker-demo.mp4</a>.
</video>

![Endpoint /health respondendo através do Swagger, servido de dentro do container](docs/docker-health.png)

## 🧠 A arquitetura do agente, em uma tabela

| Fase | O que faz | Onde está |
|---|---|---|
| **F1 — Análise & Decisão** | Classifica a tarefa (categoria, capabilities exigidas, complexidade) e decide a estratégia de execução (`direct` / `multi_agent` / `autonomous`) | `src/adaptive/taskAnalyzer.ts`, `decision.ts` |
| **F2 — Scoring & Model Router** | Rankeia os modelos disponíveis para a tarefa e escolhe o melhor, com estratégia adaptativa | `src/adaptive/scoring.ts`, `modelRouter.ts`, `strategyEngine.ts` |
| **F3 — Custo & Tokens** | Estima tokens e custo *antes* de executar, e mede o custo real depois | `src/adaptive/tokenEstimator.ts`, `costEstimator.ts` |
| **F4 — Agent Runtime** | Executa a tarefa fim a fim e mantém memória de curto prazo por sessão | `src/adaptive/runtime.ts` |
| **F5 — Orchestrator multiagente** | Para tarefas complexas: pipeline Análise → Planejamento → Código → Validação, com contexto acumulado e fail-open por etapa | `src/adaptive/orchestrator.ts` |
| **F6 — Loop autônomo** | Planeja, executa, valida e itera sozinho, com orçamento de iterações, detecção de estagnação ("no-progress") e ferramentas reais | `src/adaptive/autonomous.ts`, `planner.ts`, `validator.ts`, `budget.ts`, `progressTracker.ts` |
| **F7 — Self-evolution** | Persiste skills, scores de estratégia e reflexões em SQLite; decisões futuras usam esse histórico (feedback loop real, não só em memória) | `src/evolution/` |
| **F8 — Tools & Observabilidade** | Ferramentas reais (grep/filesystem/shell/HTTP) para o agente agir de verdade, mais rotas de observabilidade sobre o que foi aprendido | `src/adaptive/tools/`, `src/routes/observability.ts` |
| **F9 — Cognitive Cells** | Camada de células especializadas (debug, planning, research, validation, recovery, code review, config) com roteamento determinístico, delegação entre células e memória compartilhada | `src/cognitive/` |

Cada fase tem sua própria suíte de testes (ver [🧪 Rodando os
testes](#-rodando-os-testes)) e as integrações entre fases são cobertas por
testes cross-phase dedicados — F1 alimenta F2/F5/F6/F9, F7 influencia o
ranking de modelos do F2, F6 pode consultar a `RecoveryCell` do F9 quando
detecta estagnação, e assim por diante.

## ⚙️ O gateway por baixo do agente

A base do sistema continua sendo um gateway de LLM sólido — é o que garante
que todas as fases acima tenham uma camada de execução resiliente:

| Problema comum ao integrar múltiplas IAs direto no código | Como o gateway resolve |
|---|---|
| Cada provedor tem um formato de request/response diferente | Uma única interface: `{ provider, model, messages }` para qualquer um |
| Rate limit de cada provedor estoura sem aviso | Rate limiting próprio (token bucket) por chave de cliente |
| Erros transitórios (429, 5xx) derrubam a aplicação | Retry automático com backoff exponencial + jitter |
| Perguntas repetidas custam dinheiro de novo | Cache com TTL (memória, ou distribuído via Redis) |
| Uma chamada de LLM trava a requisição indefinidamente | Timeout real via `AbortController`, propagado da rota até o `fetch` do provedor — não só "para de esperar", cancela de fato |
| Trocar de provedor exige reescrever a integração inteira | Adapters intercambiáveis atrás da mesma interface (`ProviderAdapter`) |

## 🧱 Stack

| Camada | Tecnologia |
|---|---|
| Runtime | Node.js 22 |
| Linguagem | TypeScript 6 (strict mode, `noUncheckedIndexedAccess`, `noEmitOnError`) |
| Framework HTTP | Fastify 5 |
| Validação | Zod 4 |
| Persistência | SQLite (nativo, `node:sqlite`) para memória de evolução; Redis 7 opcional para cache/rate limit distribuído |
| Logging | Pino (logs estruturados em JSON, sem `console.*` no código de produção) |
| Testes | Vitest 4 — **544 testes** |
| Lint | ESLint 10 + typescript-eslint (flat config) |
| Docs da API | Swagger/OpenAPI (`@fastify/swagger`) em `/docs` |

## 📡 Endpoints

| Rota | O que faz |
|---|---|
| `GET /health` | Health check público |
| `GET /v1/models` | Lista modelos disponíveis por provedor configurado |
| `POST /v1/chat/completions` | Chat direto com um provedor (formato unificado), com cache, rate limit, retry e streaming (SSE) |
| `POST /v1/decide` | F1+F2: analisa uma tarefa e devolve a estratégia e o modelo recomendados, sem executar |
| `POST /v1/run` | F1→F9: analisa, decide e **executa** a tarefa — `direct`, `multi_agent` ou `autonomous`; aceita `useCognitive: true` para tentar o Cognitive Router antes do executor padrão |
| `POST /v1/cognitive` | Roteia uma tarefa diretamente pelas Cognitive Cells (F9), sem passar pelo agente |
| `GET /v1/cognitive/health` | Health check das Cognitive Cells |
| `GET /v1/observability/{episodes,skills,reflections,strategy-scores,curiosity,goals,metabolism,summary}/:sessionId` | F8: expõe o que o agente aprendeu/persistiu numa sessão (dados antes write-only no SQLite) |
| `GET /` | Interface web de chat com o agente (estáticos servidos via `@fastify/static`) |

Todas as rotas sob `/v1/*` exigem o header `x-api-key`. `/health`, `/docs`
e a interface web em `/` são públicas.

## 📁 Estrutura

```
src/
├── config.ts, app.ts, server.ts     # bootstrap: env (Zod), Fastify, entrypoint
├── schemas/chat.ts                  # contratos de request/response (Zod)
├── providers/                       # adapters OpenAI/Anthropic/Gemini/Groq
│   └── openAiCompatible.ts          # factory compartilhada (3 dos 4 providers)
├── lib/
│   ├── cache.ts, redisCache.ts      # CacheStore: memória ou Redis, mesma interface
│   ├── rateLimiter.ts, redisRateLimiter.ts
│   ├── retry.ts                     # backoff exponencial + jitter
│   ├── logger.ts                    # pino (createLogger + getDefaultLogger)
│   └── db/                          # SQLite: episodes, skills, reflections,
│                                     #   strategy_scores, curiosity_signals, goals, metabolism
├── adaptive/                        # F1–F6, F8
│   ├── taskAnalyzer.ts, decision.ts         # F1
│   ├── scoring.ts, modelRouter.ts, strategyEngine.ts  # F2
│   ├── tokenEstimator.ts, costEstimator.ts  # F3
│   ├── runtime.ts                           # F4 — executeTask()
│   ├── orchestrator.ts                      # F5 — pipeline multiagente
│   ├── autonomous.ts, planner.ts,           # F6 — loop autônomo
│   │   validator.ts, budget.ts, progressTracker.ts
│   └── tools/registry.ts                    # F8 — grep/filesystem/shell/HTTP reais
├── evolution/                       # F7 — skills, strategy, curiosity, goals,
│                                     #   metabolism, reflection (self-evolution)
├── cognitive/                       # F9
│   ├── router.ts                    # CognitiveRouter — classificação determinística
│   ├── supervisor.ts                # CellSupervisor — delegação, ciclo, budget, timeout
│   ├── context.ts                   # memória/contexto compartilhado entre células
│   ├── memory.ts                    # CognitiveMemory (filesystem + SQLite opt-in)
│   └── cells/                       # debug, planning, research, validation,
│                                     #   recovery, code-review, config
└── routes/
    ├── health.ts, models.ts, chat.ts
    ├── decide.ts, run.ts            # F1–F9 via HTTP
    ├── observability.ts             # F8
    └── cognitive.ts                 # F9

public/  # interface web de chat (HTML/CSS/JS puro, sem build step)
test/    # 544 testes — unitários por módulo + integração por fase + E2E cross-phase
```

## 🚀 Como rodar localmente

```bash
git clone https://github.com/isaias4321/axon.git
cd axon
npm install
cp .env.example .env   # preencha ao menos uma chave: OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY ou GROQ_API_KEY
npm run dev
```

Acesse a documentação interativa em **<http://localhost:3000/docs>**.

## 💬 Interface web de chat

Abrindo **<http://localhost:3000/>** no navegador, você tem uma interface de
chat completa para conversar com o agente — não é só um demo estático, é um
front-end de verdade (HTML/CSS/JS puro, sem build step) servido pela própria
API via `@fastify/static`.

- **Três modos de execução**, escolhidos por você a cada conversa:
  - **Automático** — chama `POST /v1/run`; o agente (F1→F6) decide sozinho
    entre resposta direta, orquestração multiagente ou loop autônomo.
  - **Cognitivo** — chama `POST /v1/run` com `useCognitive: true`, forçando
    o `CognitiveRouter` (F9) a classificar a intenção e despachar para as
    Cognitive Cells.
  - **Direto** — chama `POST /v1/chat/completions` num provedor/modelo
    específico (a lista é carregada de `GET /v1/models`), sem passar pelo
    agente.
- **Progresso real em tempo real** (modos Automático/Cognitivo): a UI abre
  o `/v1/run` em modo streaming (`stream: true`, Server-Sent Events) e
  mostra cada fase de verdade conforme ela acontece — "analisando a
  tarefa", "iteração 2/5: executando etapa X", "validando", etc. — em vez
  de um spinner genérico de "carregando". Não é simulado: são os mesmos
  eventos que o runtime (F4/F6/F5) emite internamente, os mesmos textos
  que aparecem no log do servidor.
- **Trace real embaixo de cada resposta**: em vez de só mostrar o texto, a
  UI expõe o que a API de fato retornou — estratégia escolhida, provedor e
  modelo usados, custo estimado, duração, iterações do loop autônomo (se
  houver) ou a cadeia de Cognitive Cells acionadas. Essa é a diferença real
  entre "chamar uma LLM" e "operar um agente" — a interface deixa a decisão
  visível em vez de escondê-la atrás de um chat genérico.
- **Sessão persistente**: um `sessionId` é gerado e reaproveitado entre
  mensagens (memória de curto prazo — F4); "nova" na barra lateral começa
  uma sessão em branco.
- **Memória de sessão persistente + artefatos**: toda mensagem fica salva no
  SQLite (`messages`), não só em RAM — sobrevive a um restart do container.
  Cada arquivo enviado, pasta extraída ou projeto/zip gerado vira um
  **artefato** rastreado por sessão (`artifacts` + `session_context`), com
  uma noção determinística de "artefato atual"/"projeto atual" — resolvida
  no banco, nunca adivinhada pelo LLM. Isso é o que permite perguntas como
  "tem como melhorar o projeto atual?" ou "como eu executo isso?" depois de
  enviar/gerar um zip, sem repetir o nome do arquivo. Ver `src/adaptive/artifacts.ts`.
- **Anexos e entregas de arquivos**: o botão **+** (ou arrastar e soltar)
  envia arquivos (`.zip`, `.rar`, PDFs, imagens...) para o workspace, e o
  agente consegue **ler o conteúdo** de `.zip` e de `.rar` reais (este
  último via `unrar-free`, instalado no Docker). Pedir para **criar um
  projeto** ("faça um projeto e me envie em um zip") gera todos os
  arquivos numa única chamada estruturada ao LLM (`ProjectTool` +
  `projectScaffold.ts`), compacta em `.zip` preservando as pastas, e o
  caminho do arquivo aparece na resposta como um **botão de download**.
  O agente distingue *pergunta* de *ordem*: "você consegue criar um zip?"
  é respondido em texto; "faça um projeto e me envie em zip" é executado.
  Limite conhecido: **criar** `.rar` não é possível (não existe
  codificador livre) — o agente explica e entrega `.zip`.
- A chave (`x-api-key`) fica só no `localStorage` do seu navegador e é
  enviada direto do cliente para a API — esse front-end não tem backend
  próprio, então não existe onde a chave "passar" além do seu navegador.

Por padrão a UI assume que a API está na mesma origem; em **Configurações**
(ícone de engrenagem) dá pra apontar para outra URL, útil se você servir o
front-end separado da API em produção.

## 📡 Exemplo de uso (API crua)

Se preferir integrar direto, sem a interface web:

**Chat direto** (sem o agente — só o gateway):

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-api-key: dev-key" \
  -d '{
    "provider": "openai",
    "model": "gpt-4o-mini",
    "messages": [{ "role": "user", "content": "Explique o que é RAG em uma frase." }]
  }'
```

**Deixar o agente decidir e executar** (F1→F9):

```bash
curl -X POST http://localhost:3000/v1/run \
  -H "Content-Type: application/json" \
  -H "x-api-key: dev-key" \
  -d '{
    "task": "Investigue por que a rota /v1/chat/completions está retornando 429 e proponha uma correção",
    "useCognitive": true
  }'
```

Com `useCognitive: true`, o `CognitiveRouter` classifica a intenção
(aqui, "debug") e despacha para a `DebugCell`, que pode delegar para a
`ResearchCell` (evidência real via `grep`) antes de responder — se o router
não reconhecer a intenção, o fluxo cai automaticamente no executor padrão
(fail-open, nunca quebra a requisição).

**Só decidir, sem executar:**

```bash
curl -X POST http://localhost:3000/v1/decide \
  -H "Content-Type: application/json" \
  -H "x-api-key: dev-key" \
  -d '{ "task": "Refatore o módulo de autenticação para usar JWT" }'
```

**Streaming** (Server-Sent Events): adicione `"stream": true` ao corpo de
`/v1/chat/completions` e consuma a resposta como texto incremental.

## 🧪 Rodando os testes

```bash
npm test          # roda a suíte uma vez — 544 testes
npm run typecheck # verifica tipos sem gerar build
npm run lint       # verifica qualidade/estilo de código
```

A suíte tem três partes:

- **329 testes determinísticos/offline** — cobrem F1 a F9 (análise de tarefa,
  scoring, estimativa de custo, agent runtime, orquestração, loop autônomo,
  self-evolution com SQLite, ferramentas, Cognitive Cells e integrações
  cross-phase), todos com providers de LLM mockados. Não fazem nenhuma
  chamada de rede real e não dependem de infraestrutura externa.
- **12 testes contra um Redis real** (`test/redisCache.test.ts`,
  `test/redisRateLimiter.test.ts`), incluindo um teste de concorrência que
  dispara 20 requisições simultâneas contra o mesmo balde de rate limit e
  confirma que o Lua script é atômico. Suba um Redis local antes de rodar
  `npm test` (`docker run -p 6379:6379 redis:7-alpine`) ou aponte para outro
  endereço via `REDIS_URL`. Sem Redis disponível, só esses 12 falham — o
  resto da suíte roda normalmente. No CI, um Redis já sobe automaticamente
  como service container.
- **1 teste E2E opcional contra o Gemini real** (`test/real-feedback-loop.e2e.test.ts`),
  que faz chamadas HTTP reais para provar que o feedback loop (F7) persiste
  e influencia decisões futuras entre duas execuções reais — pula
  automaticamente (`skipIf`) quando `GEMINI_API_KEY` não está configurada,
  em vez de falhar. Não roda no CI por depender de chave de API e rede.

## 🐳 Rodando com Docker

**Com Docker Compose (recomendado — sobe API + Redis com um único comando):**

```bash
cp .env.example .env   # preencha suas chaves antes de subir
docker compose up --build
```

**Com Docker puro, sem compose** (sem Redis configurado, o gateway usa cache
e rate limiting em memória — e cai para memória automaticamente mesmo com
`REDIS_URL` definido, se o Redis estiver inacessível no boot):

```bash
docker build -t axon-runtime .
docker run -p 3000:3000 --env-file .env axon-runtime
```

## ☁️ Deploy (Render — gratuito)

1. Crie um **Web Service** novo apontando para este repositório
2. **Environment**: Docker (o Render detecta o `Dockerfile` automaticamente)
3. Em **Environment Variables**, adicione as chaves do `.env.example`
   (pelo menos `GATEWAY_API_KEYS` e uma chave real de provedor)
4. **Health Check Path**: `/health`
5. Deploy — a URL pública já serve o Swagger em `/docs`

> 💡 O plano gratuito do Render hiberna após 15 min sem tráfego — aceitável
> para uma demo de portfólio, não para produção real.

## 🧠 Decisões de design

- **A chave de API nunca passa por um backend intermediário.** A interface
  web é só HTML/CSS/JS estático; ela chama `/v1/*` direto do navegador do
  usuário, com a chave que ele mesmo configurou (guardada em
  `localStorage`, nunca enviada a nenhum servidor além da própria API).
  Por isso a autenticação foi escopada para `/v1/*` — antes cobria tudo
  exceto `/health`/`/docs`, o que bloquearia até o carregamento dos
  arquivos estáticos da UI.
- **Fail-open em toda a camada de agente.** Se o `CognitiveRouter` não
  reconhece a intenção, se uma célula falha, ou se o Redis está
  configurado mas inacessível, o sistema nunca retorna erro por causa
  disso — ele cai para o próximo nível de comportamento padrão (executor
  raso, memória em disco, cache em memória). Isso é testado explicitamente,
  não só documentado.
- **Timeout com cancelamento real, não só "parar de esperar".** `/v1/run`
  cria um `AbortController` por requisição; ao estourar o limite configurado
  (`RUN_TIMEOUT_MS`, 10 minutos por padrão), o sinal
  é propagado até o loop autônomo (checado a cada iteração) e até o
  `fetch` de cada provedor via `AbortSignal.any()` — a execução em
  background é interrompida de verdade, não continua consumindo tokens de
  LLM depois da resposta HTTP já ter sido enviada.
- **Uma factory compartilhada para os provedores compatíveis com o formato
  OpenAI.** OpenAI, Gemini e Groq expõem chat completions no mesmo
  formato; os três adapters são wrappers finos sobre uma única factory
  (`openAiCompatible.ts`). Anthropic tem adapter próprio, por formato
  genuinamente diferente.
- **Cache e rate limiting distribuídos são opcionais, ativados por
  configuração**, com fallback automático para memória se o Redis estiver
  configurado mas não responder no boot — o projeto nunca fica no ar por
  causa de uma dependência opcional.
- **Fallback automático entre provedores em erro transitório, em TODO
  lugar que chama um LLM.** Se o modelo/provedor escolhido responde com um
  erro recuperável (503/UNAVAILABLE, 502/BAD_GATEWAY, 429/RATE_LIMIT,
  404/model_not_found), o runtime tenta automaticamente o próximo
  candidato do ranking (`decision.rankedCandidates`) antes de desistir —
  em vez de derrubar a tarefa inteira por um provedor específico estar
  temporariamente indisponível. Erros de configuração (401, 400) não
  disparam fallback — só indisponibilidade real do lado do provedor. A
  lógica vive num único módulo (`src/adaptive/providerFallback.ts`)
  reutilizado nos 4 lugares onde uma chamada de LLM efetivamente acontece:
  execução direta, e as 3 peças do loop autônomo (planner, executor,
  validator/critic) — center­alizar isso evita o que já aconteceu uma vez
  aqui: corrigir o fallback num lugar e esquecer os outros três, deixando
  o modo mais usado para tarefas complexas (o loop autônomo) sem proteção
  nenhuma.
- **O rate limiter distribuído usa um Lua script, não um GET+SET
  separado**, para o cálculo de token bucket ser atômico no Redis —
  validado por um teste que dispara 20 requisições concorrentes contra um
  balde com capacidade 5 e confirma que exatamente 5 passam.
- **A classificação do `CognitiveRouter` é determinística**, sem LLM
  externo e sem dependência de rede — o roteamento para as Cognitive Cells
  funciona 100% offline e é coberto por testes que não fazem I/O.
- **Self-evolution persistido, não só em memória de processo.** F7 grava
  skills, scores de estratégia e reflexões em SQLite; uma segunda execução,
  em um processo novo, carrega esse histórico e ele muda o ranking de
  modelos do F2 — testado com duas execuções reais em sequência, não só
  simulado dentro do mesmo teste.

## ⚠️ Limitações conhecidas

Nenhum sistema é perfeito, e um dos objetivos deste projeto é ser honesto
sobre onde ele ainda pode evoluir:

- **`PlanningCell` gera planos por categoria, não totalmente guiados pela
  evidência.** O plano de ação é selecionado por um template conforme a
  categoria da tarefa (`feature`/`refactor`/`debug`/`architecture`/`general`);
  o diagnóstico recebido de outras células aparece no critério de sucesso,
  mas ainda não altera os passos do plano em si (prioridade, esforço,
  quantidade de etapas). Funciona bem como estrutura determinística e
  previsível; ainda não é um planejador adaptativo ao conteúdo da evidência.
- **`ShellTool` usa uma lista de bloqueio, não uma lista de permissão.**
  Padrões conhecidos como `rm -rf` e `sudo` são bloqueados, mas qualquer
  comando fora dessa lista é permitido. Adequado para uso local/dev
  supervisionado; para expor a um agente com input não confiável em
  produção, uma allowlist explícita seria mais segura.
- **O catálogo de modelos (`src/adaptive/modelCatalog.ts`) é uma lista
  estática** — provedores descontinuam modelos com o tempo (ex.: a Groq
  desativou `llama-3.1-8b-instant` e `llama-3.3-70b-versatile` em agosto de
  2026), e um modelo descontinuado no catálogo gera 404 até alguém
  atualizar a lista manualmente. O runtime já tenta o próximo candidato do
  ranking automaticamente quando isso acontece (ver "Fallback automático"
  acima), então o sintoma vira "sempre usa o modelo mais caro" em vez de
  erro — mas vale checar `GET /v1/models` periodicamente contra a página
  de modelos do provedor.
- **Sem observabilidade de métricas/tracing** (Prometheus, OpenTelemetry) —
  hoje a visibilidade é via logs estruturados (pino) e as rotas de
  `/v1/observability/*`.
- **Sem deploy público ativo** — o `Dockerfile` e o passo a passo de deploy
  estão prontos, mas a demo roda localmente/via Docker.

## 🗺️ Possíveis evoluções

- [ ] `PlanningCell` usar a análise de complexidade/implicações para
      alterar os passos do plano, não só o texto do critério de sucesso
- [ ] Migrar `ShellTool` de denylist para allowlist configurável
- [ ] Endpoint `/metrics` em formato Prometheus
- [ ] Circuit breaker para provedores instáveis (extensão do retry existente)
- [ ] Modelos locais via Ollama
- [ ] Roteamento automático por custo/latência observados, não só estimados

## ⚠️ Nota sobre versões

Este projeto usa TypeScript 6.0.3 em vez do TypeScript 7 (compilador
reescrito em Go): no momento da criação, o `typescript-eslint` ainda não
suporta TS 7 oficialmente. Preferi um projeto com lint, typecheck e CI
100% funcionais a usar a versão mais nova por si só.

## 📄 Licença

MIT
