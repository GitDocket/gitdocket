// @docket/core — the engine. Every surface (CLI, web, MCP, App) is a thin
// client over this library; there is exactly one write path.

export {
  type Bundle,
  findRepoRoot,
  loadBundle,
  loadRepo,
  readyWorkItems,
} from "./bundle";
export {
  CONFIG_FILENAME,
  DEFAULT_BUNDLE,
  type DocketConfig,
  parseConfig,
} from "./config";
export {
  ENGINE_SEMANTICS,
  READY_QUEUE_DESCRIPTION,
} from "./engine-semantics";
export { type FileStore, InMemoryFileStore, LocalFileStore } from "./filestore";
export { applyIndex, INDEX_MARKER, renderIndex } from "./indexmd";
export {
  ALLOW_RULES,
  composeFreshnessBaseline,
  composeHook,
  defaultConfigYaml,
  deriveProjectKey,
  ensureGitignore,
  type InitAction,
  type InitResult,
  mergeClaudeSettings,
  mergeCodexConfig,
  mergeMcpJson,
  needsFrontmatter,
  proposeType,
  scaffoldFiles,
  upgradeCodexConfig,
  upgradeHookBlock,
} from "./init";
export {
  AGENT_INTENT_DISAMBIGUATION,
  AGENT_INTENT_IDS,
  AGENT_INTENTS,
  type AgentIntentContract,
  type AgentIntentId,
  agentIntent,
  DIRECT_WORK_INTENT,
  DIRECT_WORK_INTENT_ID,
  DOCKET_INTENT_DISAMBIGUATION,
  DOCKET_INTENT_IDS,
  DOCKET_INTENTS,
  type DocketIntentContract,
  type DocketIntentId,
  docketIntent,
  type IntentEntrypoint,
  type IntentMode,
  PICKUP_AUTHORITY_EVIDENCE,
} from "./intents";
export {
  type FreshnessWatermark,
  findFreshnessWatermark,
  type LintOptions,
  lintBundle,
  resolveLink,
} from "./lint";
export {
  appendLog,
  type CreateInput,
  createWorkItem,
  nextId,
  setEpic,
  setPriority,
  setRank,
  setStatus,
  slugify,
} from "./ops";
export {
  buildContextPacket,
  type CommitRef,
  type ContextPacket,
  type PacketDep,
  type PacketLink,
} from "./packet";
export {
  type Concept,
  type Decision,
  type Diagnostic,
  type GenericConcept,
  isReserved,
  type Link,
  parseConcept,
  type WorkItem,
} from "./parse";
export {
  type IntentDiscoveryDiagnostic,
  type IntentDiscoveryDiagnosticCode,
  PROMPT_ROUTING_FIXTURES,
  type PromptRoutingDiagnostic,
  type PromptRoutingDiagnosticCode,
  type PromptRoutingFixture,
  type PromptRoutingTrait,
  validateIntentDiscoveryDescriptions,
  validatePromptRoutingFixtures,
} from "./prompt-routing";
export {
  buildSchemas,
  type DecisionFrontmatter,
  type GenericFrontmatter,
  type Schemas,
  type WorkItemFrontmatter,
} from "./schema";
export { type SearchHit, searchBundle } from "./search";
export {
  formatOrigin,
  type Origin,
  parseOrigin,
  recoverOrigin,
  type ShippedHistory,
  shippedHistory,
  shippedWorkflow,
} from "./shipped";
export {
  type LegacyStateOfPlayNote,
  parseStateOfPlay,
  presentStateOfPlay,
  REENTRY_CONTEXT_FORMAT,
  REENTRY_CONTEXT_V1_FORMAT,
  type ReentryAssessment,
  type ReentryContextNote,
  type ReentryV1ContextNote,
  STATE_OF_PLAY_PATH,
  STATE_OF_PLAY_REVIEW_MAX_DAYS,
  STATE_OF_PLAY_STALE_COMMITS,
  type StateOfPlayNote,
  type StateOfPlayParseResult,
  type StateOfPlayPresentationOptions,
  type StateOfPlayReview,
  type StateOfPlayReviewReason,
  type StateOfPlayView,
} from "./state-of-play";
export {
  byManualOrder,
  canTransition,
  DECISION_STATES,
  type DecisionStatus,
  isPriority,
  isReady,
  isStatus,
  isTerminalStatus,
  PRIORITIES,
  type Priority,
  STATES,
  type Status,
  TERMINAL_STATES,
  TRANSITIONS,
  WORK_ITEM_TYPES,
  type WorkItemType,
} from "./states";
export {
  type Merge3,
  markerVersion,
  type UpgradeAction,
  type UpgradeResult,
  upgradeAdapter,
  upgradeWorkflowFile,
} from "./upgrade";
export {
  resolveVerifyMarkers,
  scanVerifyMarkers,
  VERIFY_TOKEN,
  type VerifyMarker,
  type VerifySource,
  type VerifyStatusRow,
  verifyStatus,
} from "./verify";
export { DOCKET_VERSION } from "./version";
export {
  ADAPTER_MARKER,
  composeManagedSection,
  DOCKET_WORKFLOWS,
  hasAdapterMarker,
  hasDocketSection,
  renderAgentSkillStub,
  renderClaudeSkillStub,
  renderDocketSection,
  renderWorkflow,
  validateWorkflowSemantics,
  WORKFLOWS_DIR,
  type WorkflowDef,
  type WorkflowSemantic,
  type WorkflowSemanticDiagnostic,
  workflowPath,
} from "./workflows";
