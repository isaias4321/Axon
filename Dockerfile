FROM node:22-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-slim

WORKDIR /app
# DATA_DIR fixo em /app/data: o SQLite (src/lib/db/paths.ts) cai em
# `~/.axon` por padrão, o que depende de `$HOME` resolver certo para o
# usuário não-root abaixo — fixar aqui evita qualquer ambiguidade.
ENV NODE_ENV=production AXON_WORKSPACE=/app DATA_DIR=/app/data

# unrar-free: utilitário CLI livre (GPL) capaz de LISTAR e EXTRAIR arquivos
# .rar reais — necessário porque a lib usada para .zip (adm-zip) não
# consegue ler o formato RAR (é um formato binário totalmente diferente).
# Sem isso, qualquer .rar de verdade enviado pelo usuário falhava sempre ao
# tentar listar/inspecionar seu conteúdo. Isso NÃO permite CRIAR .rar (essa
# limitação é real e permanece — RAR não tem codificador livre/open-source,
# só leitor).
RUN apt-get update \
  && apt-get install -y --no-install-recommends unrar-free \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app ./

# Roda como usuário não-root por padrão (boa prática de segurança). A
# imagem oficial do Node já vem com um usuário "node" pronto (uid/gid 1000)
# — só precisa ser dono de /app, porque a aplicação escreve ali em runtime
# (uploads, projetos gerados, o SQLite em /app/data).
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/server.js"]
