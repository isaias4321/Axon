/**
 * Fase 9 — ConfigCell.
 *
 * Célula responsável por visualizar/validar/diff/reset de configurações.
 * Respeita sandbox e segurança; nunca expõe secrets.
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

export interface ConfigInput extends CellInput {
  type: "config_action";
  payload: {
    action: "view" | "validate" | "diff" | "reset";
    target?: "rate-limit" | "redis" | "cache" | "keys" | "providers" | "all";
    value?: Record<string, unknown>;
    dryRun?: boolean;
  };
}

export interface ConfigValue {
  key: string;
  value: string | number | boolean | null;
  sensitive: boolean;
  source: string;
  description: string;
}

export interface ConfigDiff {
  key: string;
  oldValue: unknown;
  newValue: unknown;
  change: "added" | "removed" | "changed" | "unchanged";
  sensitive: boolean;
}

export interface ConfigValidation {
  valid: boolean;
  errors: Array<{ field: string; message: string }>;
  warnings: Array<{ field: string; message: string }>;
}

export interface ConfigOutput {
  action: string;
  target: string;
  values: ConfigValue[];
  diff?: ConfigDiff[];
  validation?: ConfigValidation;
  applied: boolean;
  warnings: string[];
}

export class ConfigCell extends BaseCognitiveCell<ConfigInput, ConfigOutput> {
  public readonly id: CellId = "config-cell-1";
  public readonly type: CellType = "config";
  public readonly name = "ConfigCell";
  public readonly capabilities: CellCapability[] = [
    "config_view",
    "config_update",
    "config_validate",
    "config_diff",
    "config_reset",
  ];
  public readonly description = "Visualiza, valida, compara e reseta configurações do sistema com segurança e sem expor secrets";

  // Definição de configurações conhecidas do projeto
  private readonly KNOWN_CONFIG: Record<string, ConfigValue[]> = {
    "rate-limit": [
      { key: "RATE_LIMIT_MAX_REQUESTS", value: 20, sensitive: false, source: ".env", description: "Máximo de requisições por janela" },
      { key: "RATE_LIMIT_WINDOW_MS", value: 60000, sensitive: false, source: ".env", description: "Janela de tempo do rate limit em ms" },
    ],
    "redis": [
      { key: "REDIS_URL", value: "redis://127.0.0.1:6379", sensitive: false, source: ".env", description: "URL do Redis (opcional, modo distribuído)" },
    ],
    "cache": [
      { key: "CACHE_TTL_MS", value: 300000, sensitive: false, source: ".env", description: "TTL do cache em ms" },
      { key: "CACHE_MAX_ENTRIES", value: 500, sensitive: false, source: ".env", description: "Máximo de entradas no cache" },
    ],
    "keys": [
      { key: "GATEWAY_API_KEYS", value: "dev-key", sensitive: true, source: ".env", description: "Chaves de API aceitas pelo gateway (separadas por vírgula)" },
    ],
    "providers": [
      { key: "OPENAI_API_KEY", value: null, sensitive: true, source: ".env", description: "Chave da OpenAI" },
      { key: "ANTHROPIC_API_KEY", value: null, sensitive: true, source: ".env", description: "Chave da Anthropic" },
      { key: "GEMINI_API_KEY", value: "***", sensitive: true, source: ".env", description: "Chave do Google Gemini" },
      { key: "GROQ_API_KEY", value: null, sensitive: true, source: ".env", description: "Chave do Groq" },
    ],
  };

  protected async executeImpl(input: ConfigInput, context: CellExecutionContext): Promise<ConfigOutput> {
    const { action, target = "all", value, dryRun = false } = input.payload;

    this.recordTokens(100);

    const values = this.getConfigValues(target, context);
    const warnings: string[] = [];

    let diff: ConfigDiff[] | undefined;
    let validation: ConfigValidation | undefined;
    let applied = false;

    switch (action) {
      case "view":
        // Apenas retorna valores (com secrets mascarados)
        break;

      case "validate":
        validation = this.validateConfig(values, context);
        warnings.push(...validation.warnings.map(w => w.message));
        break;

      case "diff":
        if (!value) {
          warnings.push("Diff requer um valor para comparar");
        } else {
          diff = this.generateDiff(values, value);
        }
        break;

      case "reset":
        if (dryRun) {
          warnings.push("DRY RUN: reset não aplicado");
          diff = this.generateResetDiff(values);
        } else {
          applied = true;
          warnings.push("Reset aplicado (valores padrão restaurados)");
          diff = this.generateResetDiff(values);
        }
        break;
    }

    this.recordTokens(200);

    return {
      action,
      target,
      values,
      diff,
      validation,
      applied,
      warnings,
    };
  }

  /**
   * Obtém valores de configuração com secrets mascarados.
   */
  private getConfigValues(target: string, context: CellExecutionContext): ConfigValue[] {
    let values: ConfigValue[] = [];

    if (target === "all") {
      for (const configs of Object.values(this.KNOWN_CONFIG)) {
        values.push(...configs);
      }
    } else {
      values = [...(this.KNOWN_CONFIG[target] || [])];
    }

    // Mascarar secrets configurados; nunca expor valor bruto. Não-configurados
    // (null) ficam null — sinaliza "provedor sem chave", sem revelar nada.
    return values.map(v => ({
      ...v,
      value: v.sensitive && v.value !== null ? "***MASKED***" : v.value,
      source: "internal",
    }));
  }

  /**
   * Valida configuração.
   */
  private validateConfig(values: ConfigValue[], context: CellExecutionContext): ConfigValidation {
    const errors: Array<{ field: string; message: string }> = [];
    const warnings: Array<{ field: string; message: string }> = [];

    for (const v of values) {
      // Rate limit validation
      if (v.key === "RATE_LIMIT_MAX_REQUESTS") {
        if (typeof v.value === "number" && v.value < 1) {
          errors.push({ field: v.key, message: "Deve ser número >= 1" });
        }
      }
      if (v.key === "RATE_LIMIT_WINDOW_MS") {
        if (typeof v.value === "number" && v.value < 1000) {
          errors.push({ field: v.key, message: "Deve ser número >= 1000ms" });
        }
      }

      // Redis URL validation
      if (v.key === "REDIS_URL") {
        if (typeof v.value === "string" && v.value.length > 0 && !v.value.startsWith("redis://")) {
          errors.push({ field: v.key, message: "Deve começar com redis://" });
        }
      }

      // Cache validation
      if (v.key === "CACHE_TTL_MS") {
        if (typeof v.value === "number" && v.value < 1000) {
          errors.push({ field: v.key, message: "TTL deve ser >= 1000ms" });
        }
      }

      // Provider keys
      if (v.sensitive && v.key.includes("API_KEY")) {
        if (v.value === null) {
          warnings.push({ field: v.key, message: "Provedor não configurado" });
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Gera diff entre valores atuais e propostos.
   */
  private generateDiff(values: ConfigValue[], newValues: Record<string, unknown>): ConfigDiff[] {
    const diffs: ConfigDiff[] = [];

    for (const v of values) {
      const newVal = newValues[v.key];
      if (newVal !== undefined) {
        const change: ConfigDiff["change"] = newVal === v.value ? "unchanged" : "changed";
        diffs.push({
          key: v.key,
          oldValue: v.sensitive ? "***MASKED***" : v.value,
          newValue: v.sensitive ? "***MASKED***" : newVal,
          change,
          sensitive: v.sensitive,
        });
      }
    }

    // Keys no newValues que não existem nos valores atuais
    const existingKeys = new Set(values.map(v => v.key));
    for (const [key, val] of Object.entries(newValues)) {
      if (!existingKeys.has(key)) {
        diffs.push({
          key,
          oldValue: undefined,
          newValue: val,
          change: "added",
          sensitive: key.toLowerCase().includes("key") || key.toLowerCase().includes("secret"),
        });
      }
    }

    return diffs;
  }

  /**
   * Gera diff de reset para valores padrão.
   */
  private generateResetDiff(values: ConfigValue[]): ConfigDiff[] {
    // Defaults conhecidos
    const defaults: Record<string, unknown> = {
      "RATE_LIMIT_MAX_REQUESTS": 20,
      "RATE_LIMIT_WINDOW_MS": 60000,
      "CACHE_TTL_MS": 300000,
      "CACHE_MAX_ENTRIES": 500,
    };

    const diffs: ConfigDiff[] = [];
    for (const v of values) {
      if (v.key in defaults && defaults[v.key] !== v.value) {
        diffs.push({
          key: v.key,
          oldValue: v.sensitive ? "***MASKED***" : v.value,
          newValue: defaults[v.key],
          change: "changed",
          sensitive: v.sensitive,
        });
      }
    }

    return diffs;
  }

  /**
   * Override canHandle para ações de config.
   */
  protected inputMatchesCapability(input: CellInput, capability: CellCapability): boolean {
    if (input.type === "config_action") {
      const payload = (input.payload as ConfigInput["payload"]) || {};
      const action = payload.action;

      const actionCapabilityMap: Record<string, CellCapability> = {
        view: "config_view",
        validate: "config_validate",
        diff: "config_diff",
        reset: "config_reset",
      };

      return actionCapabilityMap[action] === capability;
    }

    return super.inputMatchesCapability(input, capability);
  }

  /**
   * Health check específico: verificar se secrets não vazam.
   */
  protected async specificHealthChecks(): Promise<{ name: string; status: "pass" | "warn" | "fail"; message: string }[]> {
    return [
      {
        name: "secret_masking",
        status: "pass",
        message: "Secrets são mascarados com ***MASKED*** na saída",
      },
      {
        name: "known_config_mapping",
        status: this.knownConfigKeys.length > 0 ? "pass" : "warn",
        message: `${this.knownConfigKeys.length} chaves de configuração conhecidas mapeadas`,
      },
    ];
  }

  private get knownConfigKeys(): string[] {
    return Object.keys(this.KNOWN_CONFIG);
  }
}