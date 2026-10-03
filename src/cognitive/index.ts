/**
 * Fase 9 — Cognitive Cells System.
 *
 * Ponto de entrada público do sistema de células cognitivas.
 * Exporta tudo que é necessário para usar o CognitiveRouter e as células.
 */

// Types
export type {
  CognitiveCell,
  CellId,
  CellType,
  CellCapability,
  CellInput,
  CellOutput,
  CellExecutionContext,
  CellBudgets,
  SandboxConfig,
  CellError,
  CellHealth,
  CellHealthCheck,
  CellMessage,
  CellMessageType,
  CellMetrics,
  CellProvenance,
  CanHandleResult,
  CognitiveMemory,
  CognitiveMemoryEntry,
  MultiCellDispatchResult,
  CognitiveRouterConfig,
} from "./types.js";

// Base
export { BaseCognitiveCell } from "./cell.js";

// Router
export {
  CognitiveRouter,
  createCognitiveRouter,
} from "./router.js";
export type {
  IntentClassification,
  ExtractedEntity,
  RoutingContext,
  SingleCellDispatchResult,
} from "./router.js";

// Memory
export {
  FileSystemCognitiveMemory,
  createCognitiveMemory,
} from "./memory.js";

// Cells
export { ResearchCell } from "./cells/research.js";
export type { ResearchInput, ResearchOutput, ResearchFinding } from "./cells/research.js";
export { DebugCell } from "./cells/debug.js";
export type { DebugInput, DebugOutput, DebugDiagnosis, DebugEvidence, DebugFix } from "./cells/debug.js";
export { PlanningCell } from "./cells/planning.js";
export type { PlanningInput, PlanningOutput, PlanItem, PlanTimelinePhase, PlanRisk } from "./cells/planning.js";
export { CodeReviewCell } from "./cells/code-review.js";
export type { CodeReviewInput, CodeReviewOutput, ReviewFinding, ReviewSummary } from "./cells/code-review.js";
export { ConfigCell } from "./cells/config.js";
export type { ConfigInput, ConfigOutput, ConfigValue, ConfigDiff, ConfigValidation } from "./cells/config.js";
export { ValidationCell } from "./cells/validation.js";
export type { ValidationInput, ValidationOutput, ValidationFinding, ValidationVerdict } from "./cells/validation.js";
export { RecoveryCell } from "./cells/recovery.js";
export type { RecoveryInput, RecoveryOutput } from "./cells/recovery.js";

// Integration
export {
  createDefaultCognitiveCells,
  createCognitiveSystem,
  buildRoutingContext,
  routeWithCognitiveSystem,
  healthCheckCognitiveSystem,
  toSerializableCognitiveResult,
} from "./integration.js";
export type { CognitiveIntegrationResult } from "./integration.js";

// Supervisor (Fase 9.2 — comunicação real entre células)
export { DefaultCellSupervisor } from "./supervisor.js";
export type { SupervisorOptions, CellCallTrace } from "./supervisor.js";
export {
  CellDelegationError,
} from "./types.js";
export type {
  CellRequestArgs,
  CellDelegationReason,
} from "./types.js";