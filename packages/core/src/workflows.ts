// Canonical docket workflows. The judgment procedures that operate a
// bundle live IN the bundle as agent-neutral `type: Workflow` concepts — they
// version, link, and lint like everything else and travel with the repo.
// Tool-specific surfaces (Claude skills, CLAUDE.md/AGENTS.md sections) are
// thin generated adapters that defer to the bundle file. Bundle = source of
// truth; adapters are regenerable and safe to gitignore.

import { ENGINE_SEMANTICS } from "./engine-semantics";
import type { InitResult } from "./init";
import { DOCKET_INTENTS, type DocketIntentId } from "./intents";
import { DOCKET_VERSION } from "./version";

export const WORKFLOWS_DIR = "workflows";

export interface WorkflowDef {
  /** Kebab-case name; the bundle file is `workflows/<slug>.md`. */
  slug: string;
  title: string;
  description: string;
  /** Canonical user intent this workflow serves. */
  intent: DocketIntentId;
  /** Markdown body. Agent-neutral: imperative steps, `docket` CLI, no tool-specific framing. */
  body: string;
}

export const workflowPath = (w: WorkflowDef): string =>
  `${WORKFLOWS_DIR}/${w.slug}.md`;

// Bodies address "you", the agent executing the workflow, whatever harness it
// runs in. Engine commands are spelled `docket …` — repos that run the engine
// through a package runner note that in their agent instructions.
export const DOCKET_WORKFLOWS: readonly WorkflowDef[] = [
  {
    slug: "docket-pickup",
    title: "Pick up a task",
    intent: "pickup",
    description: DOCKET_INTENTS.pickup.discovery,
    body: `Use this workflow only for authorized tracked Docket work. Pickup authority requires positive evidence: a Docket ID, an unambiguous reference to an existing tracked item, or an explicit request to select the next Docket or backlog item. Generic implementation language does not select pickup. A concrete direct request proceeds in the user's stated scope without creating, starting, or adopting Docket work; do not invoke this workflow for it.

1. **Resolve the target and command**: a Docket ID authorizes \`docket task start <ID> --json\`. Resolve an unambiguous tracked-item reference to its ID, then use the same named command. Only explicit next-Docket-task or backlog-selection language authorizes bare \`docket task start --json\`. If an apparent tracked reference remains ambiguous, perform only focused resolution or ask for clarification; never omit the ID, substitute the top ready item, or mutate \`.docket/active-task\`.
2. **Start through the engine**: run only the command authorized in step 1. If the command fails, stop; do not rename the session or begin tracked work.
3. **Use the returned title intent**: read \`suggestedSessionTitle\` from the successful structured result. Do not rebuild it from prompt text or separately queried task fields.
4. **Best-effort rename**: ask the current harness's native adapter to name the calling session with that exact value. If the host has no current-session naming capability, the capability is unavailable, or the rename fails, continue silently without retrying or treating pickup as failed.
5. **Hand off context**: use the returned task, epic, dependency, linked-concept, and commit fields as the context packet, then begin the requested tracked work.

${ENGINE_SEMANTICS.transitions}

${ENGINE_SEMANTICS.mutationOwnership.pickup}`,
  },
  {
    slug: "docket-epic",
    title: "Supervise an epic",
    intent: "epic-supervision",
    description: DOCKET_INTENTS["epic-supervision"].discovery,
    body: `Supervise the named epic until its acceptance criteria support explicit closure or one concrete blocker prevents safe progress. Docket files and task-linked Git history are the durable source of truth. Native worker, wait, follow-up, notification, and isolated-checkout capabilities are optional accelerators; they never change readiness or completion semantics.

## 1. Establish the authoritative graph

1. Confirm the user named an epic and authorized running it, not merely reviewing it. Read the epic file, verify that it is an Epic with an ID and title, then run \`docket task list --epic <EPIC-ID> --all --json\` and \`docket ready --json\`.
2. Derive one manager title from those authoritative epic fields, exactly \`Epic <ID> — <title>\`, and retain it for the entire supervision run. Ask the current harness's native adapter to apply it to the calling manager session. Unsupported, unavailable, or failed rename capability is a silent no-op; it never blocks supervision.
3. Record the manager baseline: current Git commit and branch, working-tree state, epic status and acceptance criteria, every child status and dependency, already-linked task commits, and the stopping condition. Preserve unrelated user changes; do not hide, overwrite, or move them into a worker checkout.
4. Use the engine's ready result as authoritative. ${ENGINE_SEMANTICS.readiness} ${ENGINE_SEMANTICS.readyOrdering} Filter that result to the named epic; never dispatch from a remembered or hand-derived ready list.
5. If no child is ready but unfinished children remain, inspect their dependency and blocked-state evidence. Continue only when Docket state identifies a resolvable in-scope next action; otherwise prepare the blocker receipt in section 6.

## 2. Preflight isolation and likely write overlap

Before creating any worker, inspect each ready child's context, acceptance criteria, linked concepts, and likely implementation/test/generated-document surfaces. Parallel writing is allowed only when every selected child is dependency-independent, likely write sets are materially distinct, each worker has a separate checkout at the exact accepted manager ref, and the manager can integrate and verify results one at a time. Treat shared workflow templates, generated adapters, dependency manifests, schemas, migrations, indexes, and central registries as likely overlap unless evidence shows otherwise.

If any condition is unknown or false—or if the host lacks a verified worker, wait/follow-up, notification, or isolated-checkout binding—use the mandatory serial fallback: run exactly one child at a time in the calling session or one isolated worker, integrate it fully, refresh Docket state, and only then choose the next child. Never run concurrent writers in one checkout. A shared \`.docket/active-task\` is single-checkout state, not a coordination mechanism.

## 3. Dispatch one bounded child contract

For each selected child, provide the exact task ID, accepted baseline commit, isolated checkout or serial location, permitted scope, acceptance criteria, relevant linked concepts, expected verification, and these constraints:

- follow [the pickup workflow](/workflows/docket-pickup.md) before implementation and [the close workflow](/workflows/docket-close.md) only after the task is actually complete;
- change only the named child and required reconciliation surfaces; do not start siblings, close the epic, or invent orchestration infrastructure;
- preserve unrelated changes, use task-linked commits, clear the checkout's active-task marker after close, and return commit hashes, verification results, interventions, and exact blockers;
- do not claim integration or readiness changes from the worker checkout—the manager re-establishes those facts after accepting the result.

When no native worker binding is available, execute this same contract serially in the calling session. The contract, not process count, defines supervision.

An isolated child session follows pickup normally and keeps its own \`<ID> — <title>\` task name; never apply the manager title to that child. In the serial fallback, child pickup can temporarily rename the shared calling session, so immediately after every successful child pickup reapply the retained \`Epic <ID> — <title>\` manager title before implementation continues. A failed or unsupported restoration remains a silent no-op and does not change task state or the child contract.

## 4. Inspect and integrate one result at a time

1. Treat a worker report as a lead, not authority. Inspect its checkout or ref, diff, task file, checked or explicitly waived criteria, Outcome, Log, commit trailers, verification output, and clean active-task state.
2. Reject or return incomplete, out-of-scope, unverified, or ambiguously based work. Keep the branch/worktree/ref recoverable and state the required correction. Never mark the child done merely because the worker said it finished.
3. Integrate one accepted commit series into the manager checkout. Resolve only understood in-scope conflicts; otherwise stop integration, preserve both refs and the conflict evidence, and produce a blocker receipt. Do not integrate a second result against unresolved or unverified state.
4. Run the verification proportionate to the accepted diff, regenerate derived state with \`docket index\`, then rerun \`docket task list --epic <EPIC-ID> --all --json\` and \`docket ready --json\`. Re-read the epic and Git history. Select further work only from this refreshed state.
5. At every accepted boundary, durable task files plus integrated Git commits must be sufficient for a replacement manager to resume. Native task IDs and wait cursors are useful transient handles, never the recovery source of truth.

## 5. Review and close the epic explicitly

All children being done is necessary evidence, not epic completion. When no unfinished child remains, review every epic acceptance criterion against integrated task Outcomes, diffs, tests, decisions, and reconciled docs. Run final repository verification. If any criterion lacks evidence, create or identify the smallest in-scope follow-on child and continue; do not check or waive a criterion silently.

When every criterion is satisfied or explicitly waived with a reason, apply the close workflow to the epic itself: write its Outcome with commit evidence, reconcile affected concepts, close through the engine, regenerate the index, update the log, and commit with the epic's task trailer. Verify the integrated epic status rather than inferring it from the close command's prose.

## 6. Return one consolidated receipt

Return only after verified epic closure or a concrete blocker. Before returning, ask the native adapter to reapply the retained manager title once so the calling session ends on the epic rather than incidental child work; unsupported or failed rename remains a silent no-op. A completion receipt names the epic, integrated child and epic commits, verification performed, serial-versus-parallel choice and why, interventions or conflicts, and any deliberately deferred follow-up. A blocker receipt names the exact failing child or epic criterion, dependency/decision/error, last accepted manager commit, preserved worker refs or worktrees, current Docket state, checks already attempted, and the single action needed to resume.

Do not create an orchestration database, scheduler, permanent runner, or synthetic epic status. On interruption, restart this workflow from section 1: Docket and Git reveal completed children and the next authoritative ready set; absent native lifecycle state simply selects the serial fallback.`,
  },
  {
    slug: "docket-task",
    title: "Create a work item",
    intent: "task-management",
    description:
      "Create a task, epic, or decision as a conformant OKF concept file — ID generation, template, links, index update.",
    body: `Create a work item conformant with the OKF task profile (bundled at \`specs/okf-task-profile.md\` when the repo carries it). The request describes the item ("task: add X to Y, epic phase-1, depends on KEY-8").

**Prefer the engine**: \`docket task create --title "…" --epic /work/epics/… --deps KEY-x,KEY-y --priority p1 --description "…"\` handles ID assignment, file placement, and a conformant template. Then edit the created file to fill in real \`# Context\` links and \`# Acceptance Criteria\`, and run \`docket index\`. The manual steps below are the fallback when the engine is unavailable.

1. **Assign the ID**: work items (tasks AND epics) take the next number in the project sequence under the key from \`docket.yaml\` — \`grep -rh "^id: KEY-" <bundle>/\`, max + 1. Decisions likewise on their own prefix (default \`DEC-\`). Verify the result is unused.
2. **Write the file** at \`work/tasks/<ID>-<short-slug>.md\` (epics → \`work/epics/\`, decisions → \`decisions/\`) with frontmatter: \`type\`, \`title\`, \`description\` (one sentence), \`id\`, \`status: todo\`, \`epic\` (bundle-absolute link — ask or infer; a task without an epic is allowed but noted), \`depends_on\` (task IDs, omit if none), \`priority\` (default \`p2\`), \`assignee\`, \`tags\`, \`timestamp\` (current UTC ISO 8601).
3. **Body**: \`# Context\` — link the relevant specs/docs/decisions (bundle-absolute paths); \`# Acceptance Criteria\` — checkboxes, verifiable, few. Omit \`# Log\` until there's something to log.
4. **Regenerate the index** (\`docket index\`) and add a \`log.md\` entry when the item is notable.
5. If work starts now, follow [the pickup workflow](/workflows/docket-pickup.md). It delegates task state and context-packet mechanics to \`docket task start <ID> --json\`; never set the active task without the status move or vice versa. Pausing later is \`docket task stop\` (clears the active task, status stays).

Never skip or reuse numbers, never hand-maintain task lists inside epic files, never mark \`status\` beyond \`todo\` at creation.`,
  },
  {
    slug: "docket-groom",
    title: "Groom the backlog",
    intent: "backlog-hygiene",
    description: DOCKET_INTENTS["backlog-hygiene"].discovery,
    body: `Run this full backlog-hygiene audit only when the user explicitly asks to groom or audit the backlog, find stale or inconsistent work, or review task hygiene. Ordinary status, orientation, what-is-next, and review requests use \`docket overview --json\` instead and stop when that structured response is sufficient.

Read every file in \`work/\` and report, then apply agreed fixes. Start from the engine: \`docket ready --json\` and \`docket task list --json\`.

${ENGINE_SEMANTICS.mutationOwnership.grooming}

1. **Derive ready**: \`docket ready\` (never compute by hand). ${ENGINE_SEMANTICS.readiness} ${ENGINE_SEMANTICS.readyOrdering}
2. **Flag inconsistencies**:
   - \`in-progress\` tasks with no commits trailer-matching their ID (\`git log --grep "Task: <ID>"\`) and no Log entry in 7+ days → probably stalled; propose \`blocked\` or \`todo\`.
   - \`done\` tasks with unchecked acceptance criteria or missing \`# Outcome\`.
   - \`closed\` tasks without a concrete \`# Disposition\` and replacement links when applicable.
   - \`depends_on\` pointing at nonexistent or done-and-superseded IDs; broken bundle links (\`docket lint\`).
   - Epics without a \`spec\` link; tasks without an \`epic\` link.
   - \`index.md\` out of sync (\`docket index\` fixes; report if it changes anything).
3. **Propose, then apply**: present findings compactly; on confirmation (or when running autonomously, for mechanical fixes only) update files via \`docket task move\`/\`docket task log\`, regenerate the index, and add a \`**YYYY-MM-DD**\` line to affected \`# Log\` sections explaining status changes.
4. Commit as \`chore(docket): groom backlog\` (no task trailer — \`docket task stop\` first).

Never change priorities or close tasks without saying so; grooming narrates every mutation.`,
  },
  {
    slug: "docket-close",
    title: "Conclude a task",
    intent: "task-management",
    description:
      "Conclude a task as completed or explicitly closed without completion — narrative, doc reconciliation, index/log updates.",
    body: `Conclude the given task (default: the ID in \`.docket/active-task\`). A terminal move is the moment the wiki gets paid — don't skip steps.

${ENGINE_SEMANTICS.transitions}

${ENGINE_SEMANTICS.mutationOwnership.close}

1. **Choose the terminal meaning explicitly**. Completion is the backward-compatible default: every acceptance criterion is checked (or explicitly waived in the Outcome with a reason), and the target state is \`done\`. Use non-completion only when the user explicitly intends to abandon, decline, supersede, or otherwise discontinue the work; leave unmet criteria unchecked, target \`closed\`, and require a concrete disposition reason. If neither meaning is supported, say so and stop.
2. **Write the terminal narrative**. For completion, write \`# Outcome\`: what actually shipped, citing commit hashes found via \`git log --grep "Task: <ID>" --oneline\` plus the task file's history, with anything descoped or discovered. For non-completion, write \`# Disposition\`: why the work ended, what remains unmet, and any replacement task or decision links; do not claim that work shipped.
3. **Reconcile the docs** (the LLM-first step): from the task diff and terminal narrative, identify wiki concepts (\`specs/\`, \`reference/\`, \`decisions/\`, plan documents) the conclusion invalidates or extends. Update them now. If a choice foreclosed alternatives, record it as a \`type: Decision\` concept and link it from the Outcome or Disposition.
4. **Update state**: for completion, run \`docket task close <ID> --note "…"\`; for non-completion, run \`docket task close <ID> --without-completion --note "<disposition>"\`. Then run \`docket index\`, add a \`log.md\` entry that says completed or closed, and check dependency and epic effects. Only \`done\` unblocks dependents or counts toward epic completion; a terminal epic may be \`closed\` without all children being done.
5. **Commit everything together** — task file + reconciled docs + index/log — with the \`Task: <ID>\` trailer (keep the task active so the hook injects it, or add it manually), then \`docket task stop\` to clear the active task.

The commit that concludes a task must contain the doc reconciliation — that's the product's core promise.`,
  },
  {
    slug: "docket-standup",
    title: "Status report",
    intent: "project-maintenance",
    description:
      "Read-only status report from the bundle and git history — done since last report, in flight, ready next, blocked.",
    body: `Report project status from files + git. **Mutate nothing.** Pull state from the engine (\`docket task list --json\`, \`docket ready --json\`); use git for the activity window.

1. **Window**: since the last standup or the range given (default: 7 days).
2. **Done**: tasks whose status flipped to \`done\` in the window — from \`git log -p --since=<window> -- <bundle>/work/tasks/\` (status line changes) — one line each: ID, title, outcome gist.
3. **Closed without completion**: tasks whose status flipped to \`closed\` in the window — one line each: ID, title, and disposition; keep them separate from shipped work.
4. **In flight**: \`in-progress\` tasks with their latest Log entry and commit count from \`git log --grep "Task: <ID>" --since=<window>\`. Call out any with zero commits and no Log movement.
5. **Ready next**: derived ready list (\`docket ready\`), top 5. ${ENGINE_SEMANTICS.readiness} ${ENGINE_SEMANTICS.readyOrdering}
6. **Blocked**: \`blocked\` tasks with the blocking reason from their Log.
7. **Epic pulse**: one line per active epic — fraction of its tasks done, with closed children called out separately (derive by grep, don't trust hand-maintained lists).

Output: compact markdown suitable for pasting into a chat. Flag (don't fix) any inconsistencies noticed along the way — fixing belongs to [docket-groom](/workflows/docket-groom.md).`,
  },
  {
    slug: "docket-state-of-play",
    title: "Refresh product context",
    intent: "project-maintenance",
    description:
      "Refresh the linked project re-entry note — recent outcomes, the current frontier, and context worth remembering.",
    body: `Refresh the optional bundle-root \`overview.md\` re-entry note. The engine parses, ages, and renders this authored summary but never writes it; live task status, readiness, progress, and activity stay in the derived overview.

1. **Read the evidence**: run \`docket overview --json\`; read the product spec, current epics and tasks, recent Outcomes, explicit Decision concepts, \`log.md\`, recent task-linked commits, and the existing \`overview.md\` when present. Treat the derived overview as execution truth and the product spec/decisions as direction truth.
2. **Write only the re-entry through-line**: summarize a few recent outcomes rather than commits, then name the one or few current/next epics or frontiers—including work already underway—with enough context to understand the move. Put the canonical resume target first when one exists; multiple real frontiers remain multiple authored links rather than an engine-selected winner. Add Worth knowing only for a decision, constraint, discovery, risk, parked thread, or useful wiki destination that materially helps re-entry. Use concrete nouns and consequences, link claims to bundle evidence, and omit empty material instead of writing filler. The preserved project preamble owns the recognizable full name, concise purpose, and other durable product introduction; do not repeat it here, and do not infer missing identity. Repeat a derived fact only when it explains why something matters, never to copy an inventory.
3. **Write the linked note**: use the full output of \`git rev-parse HEAD\` as \`as_of\` and the current UTC ISO-8601 time as \`reviewed_at\`. What we've done recently and What's up next are required and non-empty. Worth knowing is optional; omit the heading when it would be empty.

   \`\`\`markdown
   ---
   format: re-entry/v2
   as_of: <full commit sha>
   reviewed_at: <timestamp>
   ---

   # Project re-entry

   ## What we've done recently

   - <outcome and consequence with a link to evidence>

   ## What's up next

   - <current or next frontier and why it matters, linked to its epic or task>

   ## Worth knowing

   - <optional decision, constraint, discovery, risk, or parked thread with a useful link>
   \`\`\`

4. **Apply freshness honestly**: five task-linked commits after \`as_of\` or fourteen days after \`reviewed_at\` makes the note need review. Renderers keep the visibly dated last-known context readable rather than hiding it or presenting it as fresh. Refresh when the re-entry through-line materially changes, not merely to reset a clock. After a task close that changes the note, stamp the close commit in a separate tracker-only refresh so it starts at zero task-linked commits behind.
5. **Verify and commit**: run \`docket overview\` and \`docket lint\`; confirm the linked sections and freshness are accurate. Commit as \`chore(docket): refresh product context\` with no Task trailer (\`docket task stop\` first).

A missing \`overview.md\` is valid and renders no placeholder. Earlier formats remain readable and unchanged, but renderers label legacy prose and \`re-entry/v1\` as needing review. Never migrate them automatically; the next meaningful refresh replaces the file with the linked form above.`,
  },
  {
    slug: "docket-freshness",
    title: "Doc-freshness sweep",
    intent: "project-maintenance",
    description:
      "Retrospective doc-freshness review — sweep commits since the last watermark, catch wiki drift that close-time reconciliation missed, stamp a new watermark.",
    body: `Close-time reconciliation is prospective — it fires only when a task closes, and only for that task's diff. This workflow is the retrospective complement: periodically re-ask "what does this invalidate?" across everything that happened since the last sweep.

1. **Find the anchor**: the most recent \`**Freshness**\` entry in \`log.md\` holds the watermark sha. If none exists (first run), sweep the full history.
2. **Collect the range**: \`git log <sha>..HEAD --name-only\` (keep trailers). Partition the commits:
   - **Trailerless** — the high-risk bucket: nobody ever asked the reconciliation question. Give each the full treatment: from its changed paths, which concepts (\`specs/\`, \`reference/\`, \`decisions/\`, plan documents) does it invalidate or extend?
   - **Trailered** (\`Task: KEY-n\`) — reconciliation should have happened at close. Spot-check: did closes that plausibly invalidated docs actually touch them?
3. **Rotate a deep read**: pick the 1–2 concepts in \`specs/\` and \`reference/\` with the oldest last-modified commit and verify their content against current reality (code, plan). This catches drift that has no local commit at all — don't skip it just because the commit range is clean.
4. **Propose, then apply**: present findings compactly (per doc: what's stale, which commit made it so). On confirmation — or autonomously for unambiguous factual fixes only — update the docs.
5. **Stamp the watermark**: append to today's section of \`log.md\`:

   \`\`\`
   - **Freshness** — reviewed through \`<short-sha of HEAD>\` (<n> commits, <k> trailerless): <one-line findings summary, or "no drift found">.
   \`\`\`

   A "no drift found" stamp is a real result — record it; the recorded null finding is what makes the next sweep cheap.
6. Commit doc fixes and the watermark together as \`chore(docket): freshness review\` (\`docket task stop\` first — no task trailer).

Never end a sweep without stamping the watermark, even when nothing changed.`,
  },
];

export type WorkflowSemantic =
  | "readiness"
  | "ready-ordering"
  | "state-transitions"
  | "mutation-ownership";

export interface WorkflowSemanticDiagnostic {
  slug: string;
  semantic: WorkflowSemantic;
  message: string;
}

const SEMANTIC_REQUIREMENTS: Readonly<
  Record<string, readonly { semantic: WorkflowSemantic; claim: string }[]>
> = {
  "docket-pickup": [
    { semantic: "state-transitions", claim: ENGINE_SEMANTICS.transitions },
    {
      semantic: "mutation-ownership",
      claim: ENGINE_SEMANTICS.mutationOwnership.pickup,
    },
  ],
  "docket-epic": [
    { semantic: "readiness", claim: ENGINE_SEMANTICS.readiness },
    { semantic: "ready-ordering", claim: ENGINE_SEMANTICS.readyOrdering },
  ],
  "docket-groom": [
    { semantic: "readiness", claim: ENGINE_SEMANTICS.readiness },
    { semantic: "ready-ordering", claim: ENGINE_SEMANTICS.readyOrdering },
    {
      semantic: "mutation-ownership",
      claim: ENGINE_SEMANTICS.mutationOwnership.grooming,
    },
  ],
  "docket-close": [
    { semantic: "state-transitions", claim: ENGINE_SEMANTICS.transitions },
    {
      semantic: "mutation-ownership",
      claim: ENGINE_SEMANTICS.mutationOwnership.close,
    },
  ],
  "docket-standup": [
    { semantic: "readiness", claim: ENGINE_SEMANTICS.readiness },
    { semantic: "ready-ordering", claim: ENGINE_SEMANTICS.readyOrdering },
  ],
};

const CONTRADICTORY_CLAIMS: readonly {
  semantic: WorkflowSemantic;
  pattern: RegExp;
  label: string;
}[] = [
  {
    semantic: "ready-ordering",
    pattern: /dependency depth/i,
    label: "dependency depth does not order the ready queue",
  },
  {
    semantic: "ready-ordering",
    pattern: /(?:ready list|ready queue)[^\n.]*priority[- ]ordered/i,
    label: "priority alone does not order the ready queue",
  },
  {
    semantic: "readiness",
    pattern: /ready (?:is|means) (?:a )?stored status/i,
    label: "ready is derived rather than stored",
  },
  {
    semantic: "state-transitions",
    pattern: /(?:workflow|adapter) owns (?:the )?status transition/i,
    label: "the engine owns status transitions",
  },
];

/**
 * Release guard for workflow claims that mirror engine behavior. Requirements
 * make omission loud; contradiction checks catch the known classes of drift.
 */
export function validateWorkflowSemantics(
  workflows: readonly Pick<WorkflowDef, "slug" | "body">[],
): WorkflowSemanticDiagnostic[] {
  const diagnostics: WorkflowSemanticDiagnostic[] = [];
  for (const workflow of workflows) {
    for (const requirement of SEMANTIC_REQUIREMENTS[workflow.slug] ?? []) {
      if (!workflow.body.includes(requirement.claim)) {
        diagnostics.push({
          slug: workflow.slug,
          semantic: requirement.semantic,
          message: `missing canonical ${requirement.semantic} claim`,
        });
      }
    }
    for (const contradiction of CONTRADICTORY_CLAIMS) {
      if (contradiction.pattern.test(workflow.body)) {
        diagnostics.push({
          slug: workflow.slug,
          semantic: contradiction.semantic,
          message: contradiction.label,
        });
      }
    }
  }
  return diagnostics;
}

/**
 * Render a workflow as a bundle concept file. `origin` records provenance
 * which shipped text this copy descends from, so a later
 * `docket upgrade` can 3-way merge against that base. Unknown field to OKF
 * consumers — tolerated, never required.
 */
export function renderWorkflow(w: WorkflowDef, timestamp: string): string {
  return `---
type: Workflow
title: ${w.title}
description: ${w.description}
origin: ${w.slug}@${DOCKET_VERSION}
tags: [docket, workflow]
timestamp: ${timestamp}
---

${w.body}
`;
}

/**
 * Marks a file as a generated adapter: init may overwrite anything carrying
 * it, and skips (never clobbers) anything without it. Carries the engine
 * version so upgrade can report current → available.
 */
export const ADAPTER_MARKER = `<!-- generated by docket init@${DOCKET_VERSION} — edits are overwritten; the workflow in the bundle is the source of truth -->`;

/** True when the text carries an adapter marker, versioned or in the legacy unversioned form. */
export const hasAdapterMarker = (text: string): boolean =>
  text.includes("<!-- generated by docket init");

/** Harness skill stub: trigger surface plus any bounded native capability binding. */
export function renderAgentSkillStub(
  w: WorkflowDef,
  bundle: string,
  nativeBinding?: string,
): string {
  const dir = bundle.endsWith("/") ? bundle : `${bundle}/`;
  const binding = (() => {
    if (w.slug === "docket-pickup")
      return `

## Native current-session rename binding

${nativeBinding ?? "This target declares current-session rename unsupported. Skip the optional rename without warning and continue the canonical workflow."}`;
    if (w.slug === "docket-epic")
      return `

## Native epic-supervision lifecycle binding

${nativeBinding ?? "This target declares current-session rename unsupported and has no verified native worker lifecycle binding. Skip manager-title application and restoration without warning, run the canonical workflow serially in the calling session, and do not infer worker creation, concurrent writing, waiting, follow-up, notification, or isolated-checkout support."}`;
    return "";
  })();
  return `---
name: ${w.slug}
description: ${w.description}
---

${ADAPTER_MARKER}

Read \`${dir}${workflowPath(w)}\` and execute its steps against this repo's bundle. That file is the source of truth; this skill only routes to it.${binding}
`;
}

/** Compatibility name for callers written before agent targets were generic. */
export const renderClaudeSkillStub = renderAgentSkillStub;

const SECTION_BEGIN = `<!-- >>> docket@${DOCKET_VERSION} >>> -->`;
const SECTION_END = "<!-- <<< docket <<< -->";
// Matches the begin marker at any version, and the legacy unversioned form.
const SECTION_BEGIN_RE = /<!-- >>> docket(@\S+)? >>> -->/;

/** True when the text carries a docket section span (any marker version). */
export const hasDocketSection = (text: string): boolean =>
  SECTION_BEGIN_RE.test(text) && text.includes(SECTION_END);

/** The shared CLAUDE.md/AGENTS.md section pointing agents at engine + workflows. */
export function renderDocketSection(project: string, bundle: string): string {
  const dir = bundle.endsWith("/") ? bundle : `${bundle}/`;
  const orientation = DOCKET_INTENTS.orientation;
  const list = DOCKET_WORKFLOWS.map(
    (w) => `- \`${dir}${workflowPath(w)}\` — ${w.description}`,
  ).join("\n");
  return `${SECTION_BEGIN}
## Docket

This repo tracks docs and work with Docket: every doc and work item is a markdown concept in \`${dir}\` (one link graph). Files are the source of truth; commits link to tasks via \`Task: ${project}-<n>\` trailers.

**Engine** — the \`docket\` CLI is the write path: \`ready\`, \`overview\`, \`search\`, \`task list|create|start|stop|move|edit|close|log\`, \`lint\`, \`index\`, \`upgrade\` (all support \`--json\`). Use it for mechanics; never hand-edit status fields or the generated \`index.md\` body.

**Orientation** — for “what's next,” status, orientation, or an ordinary review, run \`${orientation.defaultEntrypoint.value}\`. This path is read-only and bounded: start with its structured result, follow bundle links only when the requested explanation needs more evidence, and do not start a task, regenerate the index, invoke a mutating workflow, or search unrelated implementation and fixture content when the overview is sufficient. Native skills are optional: without one, run the CLI command directly; an MCP-only client calls the read-only \`overview\` tool, which returns the same model and selection.

**Workflows** — the judgment procedures live in the bundle; read the file and follow it:

${list}

**Direct and tracked work** — a concrete direct request proceeds in the user's stated scope without creating, starting, selecting, or adopting Docket work; generic implementation language is not pickup authority. Use the \`docket-pickup\` workflow only when the user supplies a Docket ID, an unambiguous reference to an existing tracked item, or an explicit request to select the next Docket/backlog item. Resolve a tracked reference to its ID before starting it. If the reference remains ambiguous, perform a focused resolution or ask for clarification; never fall back to an unrelated top-ready item. Bare \`docket task start --json\` is permitted only for explicit next-Docket-task or backlog selection. Once pickup is authorized, the engine sets \`.docket/active-task\`, moves the selected task to \`in-progress\`, and returns the context packet plus one canonical \`suggestedSessionTitle\`; an installed native adapter may apply that title to the calling session on a best-effort basis. Unsupported hosts continue normally. Pause tracked work with \`docket task stop\` (clears the active task, status stays); conclude through \`docket task close\` + the close workflow. The command completes to \`done\` by default; \`--without-completion --note "<reason>"\` explicitly records \`closed\` instead.

**Epic supervision** — when the user explicitly asks to run or supervise a named epic through completion, follow the \`docket-epic\` workflow. Native worker, wait/follow-up, notification, and isolated-checkout bindings are optional; without a verified binding, execute its mandatory serial path in the calling session. Docket files and task-linked Git history remain authoritative across interruption.
${SECTION_END}
`;
}

/**
 * Compose the docket section into an agent-instructions file (CLAUDE.md,
 * AGENTS.md). Missing file → create; no markers → append; markers present →
 * regenerate just the marked span, preserving everything around it.
 */
export function composeManagedSection(
  existing: string | undefined,
  section: string,
): InitResult {
  if (existing === undefined) return { action: "create", content: section };
  const begin = existing.match(SECTION_BEGIN_RE)?.index ?? -1;
  const end = existing.indexOf(SECTION_END);
  if (begin >= 0 && end > begin) {
    const next =
      existing.slice(0, begin) +
      section.trimEnd() +
      existing.slice(end + SECTION_END.length);
    return next === existing
      ? { action: "skip", content: existing, reason: "up to date" }
      : { action: "update", content: next };
  }
  const base = existing.endsWith("\n") ? existing : `${existing}\n`;
  return { action: "update", content: `${base}\n${section}` };
}
