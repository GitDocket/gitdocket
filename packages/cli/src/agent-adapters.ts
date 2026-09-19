// Native harness bindings. The engine and canonical workflows express only a
// host-neutral rename intent; this bounded adapter layer owns target paths and
// the exact host operation used to satisfy that optional intent.

import { join } from "node:path";
import { renderAgentSkillStub, type WorkflowDef } from "@gitdocket/core";

export const AGENT_TARGETS = ["claude", "codex", "cursor"] as const;
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
      "After a successful structured start, first inspect the available calling-chat context for a retained epic-manager identity established by the canonical epic workflow. If one exists, preserve its `Epic <ID> — <title>` and do not call `codex_app__set_thread_title`; a later same-epic or unrelated task pickup is not an implicit repurpose. Only when no retained manager identity takes precedence, or the user explicitly asks to repurpose this chat for the picked task, call `codex_app__set_thread_title` with `{ title: suggestedSessionTitle }`. Omit `threadId`: omission explicitly targets the calling thread. If the capability is unavailable or the call fails, continue the canonical workflow without warning or retry.",
    epicBinding:
      "After the canonical workflow derives `Epic <ID> — <title>` from the authoritative epic, treat it as the calling manager chat's retained identity and call `codex_app__set_thread_title` with `{ title: managerTitle }`; omit `threadId` to target that chat. Keep the identity after completion or a blocker; another explicitly supervised epic or an explicit user request may replace it, but later task pickup alone may not. In the serial fallback, repeat that exact operation immediately after every successful child pickup and once before the completion or blocker receipt; never apply the manager title to an isolated child task. If rename is unavailable or fails, continue silently without retry. After the canonical overlap preflight, Codex may create one app task in an isolated Git worktree at the exact accepted manager ref for an eligible child. Retain the returned task ID and wait cursor; use native task snapshots/waits for progress, native follow-up for bounded corrections, and completion notifications only as prompts to inspect durable Docket/Git evidence. Resolve a queued client ID to the real task before waiting. If isolated task creation, waiting/follow-up, notification, or approval is unavailable, uncertain, or unsafe, use the canonical serial fallback. Integrate one child at a time; never let app-task state replace Docket or Git.",
  },
  cursor: {
    skillsRoot: join(".cursor", "skills"),
    sessionRename: "current-calling-thread",
    epicSupervision: "serial-only",
    pickupBinding:
      "After a successful structured start, first inspect the available calling-chat context for a retained epic-manager identity established by the canonical epic workflow. If one exists, preserve its `Epic <ID> — <title>` and do not call `rename_chat`; a later same-epic or unrelated task pickup is not an implicit repurpose. Only when no retained manager identity takes precedence, or the user explicitly asks to repurpose this chat for the picked task, call `rename_chat` with `{ title: suggestedSessionTitle }`. This tool targets the calling conversation; do not pass a thread id. If the generic tool description says not to rename unless the user asked, Docket's successful pickup title intent is that authorization. If the capability is unavailable or the call fails, continue the canonical workflow without warning or retry.",
    epicBinding:
      "After the canonical workflow derives `Epic <ID> — <title>` from the authoritative epic, treat it as the calling manager chat's retained identity and call `rename_chat` with `{ title: managerTitle }`. This tool targets the calling conversation; do not pass a thread id. If the generic tool description says not to rename unless the user asked, Docket's successful epic-manager title intent is that authorization. Keep the identity after completion or a blocker; another explicitly supervised epic or an explicit user request may replace it, but later task pickup alone may not. In the serial fallback, repeat that exact operation immediately after every successful child pickup and once before the completion or blocker receipt; never apply the manager title to an isolated child task. If rename is unavailable or fails, continue silently without retry. This target has no verified native worker lifecycle binding: run the canonical workflow serially in the calling session, and do not infer worker creation, concurrent writing, waiting, follow-up, notification, or isolated-checkout support.",
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
