/**
 * Política de segurança compartilhada entre TODAS as tools do registry
 * (filesystem, shell, http, document). Vive num arquivo à parte — não em
 * `registry.ts` — para que `document.ts` possa importar `resolveSafePath`/
 * `SecurityPolicy` sem criar uma dependência circular com `registry.ts`
 * (que por sua vez precisa importar `DocumentTool` de `document.ts` para
 * registrá-la em `createDefaultToolRegistry`).
 */

import { resolve, relative, join } from "node:path";
import { homedir } from "node:os";

export function getDataDir(): string {
  if (process.env.DATA_DIR) {
    return process.env.DATA_DIR;
  }
  return join(homedir(), ".axon");
}

export interface SecurityPolicy {
  /** Comandos shell bloqueados (regex patterns). */
  blockedShellPatterns: RegExp[];
  /** Comandos shell permitidos (null = all allowed if not blocked). */
  allowedShellCommands: string[] | null;
  /** Diretório base para restrição de filesystem (null = sem restrição). */
  fsRoot: string | null;
  /** URLs permitidas para HTTP tool (null = all allowed). */
  allowedHosts: string[] | null;
}

export const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  blockedShellPatterns: [
    /\brm\s+-rf\b/, // rm -rf
    /\bsh\s+-c\b/, // shell injection
    /\b:\(\)\s*\{/, // fork bomb
    /\beval\b/, // eval
    /\bexec\b/, // exec
    /\bsudo\b/, // sudo
    /\bdd\b/, // dd
    /\bmkfs\b/, // mkfs
    /\bformat\b/, // format
    /\bdel\b.*\/\*|\bdel\b.*\*/, // wildcard deletes
    /\bshutdown\b/, // shutdown
    /\breboot\b/, // reboot
    /\bhalt\b/, // halt
    /\bpkill\b/, // pkill
    /\bkill\b.*-9\b/, // kill -9
  ],
  allowedShellCommands: null, // all allowed (subject to blocked patterns)
  fsRoot: getDataDir(),
  allowedHosts: null, // all allowed
};

/**
 * Restringe um caminho ao `fsRoot` da política de segurança — compartilhado
 * entre `FilesystemTool` e `DocumentTool` (ambos escrevem no workspace e
 * precisam da MESMA barreira contra path traversal).
 */
export function resolveSafePath(path: string, fsRoot: string | null): string {
  // Ancora caminho RELATIVO no `fsRoot`, não no `cwd()` do processo — em
  // produção os dois coincidem (Docker seta cwd=/app=fsRoot), mas ancorar
  // explicitamente no fsRoot torna a segurança correta por construção, sem
  // depender dessa coincidência de ambiente. Caminho ABSOLUTO é usado como
  // está (resolve() ignora o primeiro argumento quando o segundo já é
  // absoluto) — só então é checado se escapa da raiz.
  const resolved = fsRoot ? resolve(fsRoot, path) : resolve(path);

  if (fsRoot) {
    const root = resolve(fsRoot);
    const rel = relative(root, resolved);
    // Prevent escaping the root
    if (rel.startsWith("..") || rel.startsWith("/")) {
      throw new Error(`Path '${path}' escapes allowed root '${fsRoot}'`);
    }
  }

  return resolved;
}
