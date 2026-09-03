// Native harness bindings. The engine and canonical workflows express only a
// host-neutral rename intent; this bounded adapter layer owns target paths and
// the exact host operation used to satisfy that optional intent.

import { join } from "node:path";
import { renderAgentSkillStub, type WorkflowDef } from "@docket/core";

export const AGENT_TARGETS = ["claude", "codex"] as const;
export type AgentTarget = (typeof AGENT_TARGETS)[number];

export interface AgentAdapter {
  skillsRoot: string;
  instructions?: string;
  sessionRename: "unsupported" | "current-calling-thread";
  pickupBinding?: string;
  epicSupervision: "serial-only" | "isolated-app-tasks";
  epicBinding?: string;
}

export const AGENT_ADAPTERS: Record<AgentTarget, AgentAdapter> = {
  claude: {
    skillsRoot: join(".claude", "skills"),
    instructions: "CLAUDE.md",
    sessionRename: "unsupported",
    epicSupervision: "serial-only",
  },
  codex: {
    skillsRoot: join(".agents", "skills"),
    sessionRename: "current-calling-thread",
    epicSupervision: "isolated-app-tasks",
    pickupBinding:
      "After a successful structured start, call `codex_app__set_thread_title` with `{ title: suggestedSessionTitle }`. Omit `threadId`: omission explicitly targets the calling thread. If the capability is unavailable or the call fails, continue the canonical workflow without warning or retry.",
    epicBinding:
      "After the canonical workflow derives `Epic <ID> — <title>` from the authoritative epic, call `codex_app__set_thread_title` with `{ title: managerTitle }` and omit `threadId` to target the calling manager thread. In the serial fallback, repeat that exact operation immediately after every successful child pickup and once before the completion or blocker receipt; never apply the manager title to an isolated child task. If rename is unavailable or fails, continue silently without retry. After the canonical overlap preflight, Codex may create one app task in an isolated Git worktree at the exact accepted manager ref for an eligible child. Retain the returned task ID and wait cursor; use native task snapshots/waits for progress, native follow-up for bounded corrections, and completion notifications only as prompts to inspect durable Docket/Git evidence. Resolve a queued client ID to the real task before waiting. If isolated task creation, waiting/follow-up, notification, or approval is unavailable, uncertain, or unsafe, use the canonical serial fallback. Integrate one child at a time; never let app-task state replace Docket or Git.",
  },
};

export function renderTargetSkillStub(
  adapter: AgentAdapter,
  workflow: WorkflowDef,
  bundle: string,
): string {
  const binding =
    workflow.slug === "docket-pickup"
      ? adapter.pickupBinding
      : workflow.slug === "docket-epic"
        ? adapter.epicBinding
        : undefined;
  return renderAgentSkillStub(workflow, bundle, binding);
}
