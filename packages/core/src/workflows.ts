// Canonical docket workflows. The judgment procedures that operate a
// bundle live IN the bundle as agent-neutral `type: Workflow` concepts — they
// version, link, and lint like everything else and travel with the repo.
// Tool-specific surfaces (Claude skills, CLAUDE.md/AGENTS.md sections) are
// thin generated adapters that defer to the bundle file. Bundle = source of
// truth; adapters are regenerable and safe to gitignore.

import { ENGINE_SEMANTICS } from "./engine-semantics";
import { PROJECT_GUIDANCE_PATH } from "./guidance";
import type { InitResult } from "./init";
import { DOCKET_INTENTS, type DocketIntentId } from "./intents";
import { MARKDOWN_AUTHORING_RULE } from "./markdown-prose";
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
const WORKFLOW_DEFINITIONS: readonly WorkflowDef[] = [
  {
    slug: "docket-wiki",
    title: "Author wiki knowledge",
    intent: "wiki-authoring",
    description: DOCKET_INTENTS["wiki-authoring"].discovery,
    body: `Use this workflow when the user asks to create or revise ordinary wiki knowledge, or move or rename an ordinary wiki page. It does not create, start, stop or adopt tracked work, read or clear an unrelated active-task marker, execute a recorded procedure or activate project guidance. Route Tasks and Epics to the work-item workflow, Decisions to its supported decision path, and explicitly selected project standards to [guidance management](/workflows/docket-guidance.md). Do not reinterpret descriptive knowledge as a chosen standard.

1. **Resolve before authoring**. Read optional project guidance and only relevant scoped sources. Search the configured bundle using \`docket search <topic> --json\` (MCP \`search\`), then read likely matches and their relevant links. Resolve a named page by exact path; clarify only when multiple matches materially change the requested meaning. Reuse the authoritative existing page for revisions or repeated capture requests; a matching title alone does not prove equivalence. Report a no-op when the requested knowledge is already present.
2. **Choose scope and type**. Use Reference for stable explanatory knowledge, Spec for desired behavior and requirements, or Playbook for a repeatable domain procedure. Prefer \`reference/<slug>.md\`, \`specs/<slug>.md\` or \`playbooks/<slug>.md\` with a readable lowercase hyphenated slug. Paths are relative to the configured bundle, never a hard-coded repository directory. Do not write work, decisions, workflows, installed extensions, generated indexes or guidance through ordinary creation. Preserve unrelated prose and metadata.
3. **Prepare complete content**. Supply a useful title, one-sentence description, suitable tags and a complete Markdown body; the engine adds type and timestamp. Explain purpose and relevant context, use useful bundle-absolute links to existing knowledge, and add a relevant inbound link when it improves navigation. Keep paragraphs and simple list items on single source lines. Recording prerequisites, checks and recovery steps never authorizes running them.
4. **Create or revise through the engine**. For creation, write a JSON request file containing \`path\`, \`type\`, \`title\`, \`body\` and optional \`description\`/\`tags\`, then run \`docket document create --input <file> --json\`; MCP-only agents call \`document_create\` with the same fields. Existing paths fail without overwrite: inspect the source and choose an explicit update or another location. For revision, read \`docket document read <path> --json\` / \`document_read\` to obtain the complete body and version, then save \`{expectedVersion, patch: {body, title, description}}\` through \`docket document edit <path> --input <file> --json\` / \`document_edit\`. Omit unchanged fields. Never use paged source excerpts as replacement bodies. A conflict requires rereading and reconciling the newer source before retrying; there is no force overwrite. Engine creation does not require direct Markdown file writes; older engines missing these operations need an explicit engine upgrade before this workflow's write steps.
5. **For an explicitly requested path rename or move**, distinguish it from a title-only edit (which keeps the path). Run \`docket document move-plan <from> <to> --json\` / MCP \`document_move_plan\` with bundle-relative source and destination. Inspect the affected paths, link replacements, blockers and unmanaged-reference warnings before writing. Only ordinary Reference, Spec and Playbook sources can move; protected/owned sources, collisions and case-only moves are refused. Supported inline Markdown links, images and reference definitions retain fragments; relative outgoing links rebase to preserve their targets. Code, labels and metadata remain unchanged. Affected HTML, frontmatter or owned-source references require explicit reconciliation first; outside-bundle references are not claimed repaired. If applicable, save only \`{from,to,expectedVersion: <plan.version>}\` to a JSON request file and run \`docket document move-apply --input <file> --json\` / MCP \`document_move_apply\`. This recomputes the plan and rejects any changed bundle snapshot, including new incoming references. Successful moves refresh the derived index and expose the new path. If the result is \`recovery_required\`, keep its token and run \`docket document move-recover <token> --json\` / MCP \`document_move_recover\`; original and planned bytes remain in its hidden journal. Recovery validates the journal and refuses unrelated edits. Reconcile explicitly using those backups if needed; never blindly overwrite newer source or delete the original to force a move. Do not report completion until recovery is complete.

6. **Reconcile and verify**. After a change run \`docket index\` (MCP \`index\`) to refresh derived discovery, then \`docket lint --json\` (MCP \`lint\`). Review link, metadata and hard-wrapped prose diagnostics; fix only those caused by the requested change and report pre-existing issues separately. On no-op requests do not regenerate discovery. Inspect the final diff for unrelated edits, duplicate authority and accidental tracker/guidance changes. Follow the user's commit policy without adopting an unrelated task trailer. Return links to the saved sources and a concise description of the change and validation.`,
  },
  {
    slug: "docket-guidance",
    title: "Manage project guidance",
    intent: "project-guidance",
    description: DOCKET_INTENTS["project-guidance"].discovery,
    body: `Use this workflow for explicit remember, show, revise or retire requests about project standards and procedures. Inspection is read-only. Guidance authoring is not task pickup: do not create/start/stop work or read, adopt or clear an unrelated active-task marker. Combined explicit tracking requests keep their independent authority and workflow.

1. **Resolve existing sources**. Read the optional \`reference/project-guidance.md\` relative to the configured bundle and relevant linked sources; absence is valid. Use ordinary file reads or the bounded \`docket source reference/project-guidance.md --json\` / MCP \`source_page\` reader, following continuation cursors. Inspect focused document/search results when needed to find an existing authoritative instruction or procedure before creating one. An unreadable or invalid entry point is not an empty policy: report the problem and repair only within the requested scope.
2. **Inspect or settle meaning**. For show requests, return the actual instruction, readable scope, requirement/preference distinction and source links; do not change files, regenerate the index or inspect tracker state. For a requested change, preserve the user's meaning and scope. A descriptive observation is not automatically a selected standard. Apply explicit user direction and applicable host/repository instruction precedence. Surface unresolved contradictory guidance; ask only when material ambiguity affects meaning or blocks the request, without silently weakening either instruction. Continue independent authorized work.
3. **Remember or revise**. Explicitly requested changes proceed in scope without another approval. Reuse or update the existing entry/source; a repeated unchanged request is a no-op. If the entry point is absent, create it as an ordinary \`type: Reference\` concept with a title and description. Keep short chosen requirements/preferences under \`# General standards\` and readable scoped links under \`# Scoped guidance\`; these are prose conventions, not a policy language. Link existing Reference or Playbook sources instead of duplicating their bodies or copying AGENTS.md. Read the latest source before editing and preserve unrelated changes. When revising a shared procedure, account for its other uses and limit the change to the user's authority.
4. **Record procedures without executing them**. Capture reusable prerequisites, steps, checks and recovery context in the authoritative procedure, with a plain-language scope link. Exclude credentials and incidental runtime output. Saving or reading a deployment procedure never authorizes a deployment or rehearsal; execution requires a separate user request under host permissions.
5. **Retire deliberately**. Remove the requested instruction or scoped link from the active entry point. Removing a link does not delete a shared source document. Keep the reason and any successor source reviewable in Git or a clearly inactive history document; do not leave the superseded rule as an unexplained active instruction. Retiring an already absent entry is a no-op. Do not delete other instructions or infer retirement from implementation divergence.
6. **Verify and report the source change**. Review the diff for requested meaning, scope, duplicate authority and unresolved conflicts. Validate explicit links with \`docket lint --json\`; regenerate \`docket index\` only when guidance actually changed. These mechanics do not authorize work-state changes. Preserve normal Markdown/Git history under the user's commit policy without consulting an unrelated active marker. Return the source links and what changed (or the unchanged/absent result). Fresh sessions or an explicit reread observe saved guidance; an already-running agent is not guaranteed to refresh instantly.

Docket supplies discoverable instructions and source evidence, not deterministic enforcement of agent behavior.`,
  },
  {
    slug: "docket-pickup",
    title: "Pick up a task",
    intent: "pickup",
    description: DOCKET_INTENTS.pickup.discovery,
    body: `Use this workflow only for authorized tracked Docket work. Pickup authority requires positive evidence: a Docket ID, an unambiguous reference to an existing tracked item, or an explicit request to select the next Docket or backlog item. Generic implementation language does not select pickup. A concrete direct request proceeds in the user's stated scope without creating, starting, or adopting Docket work; do not invoke this workflow for it.

1. **Resolve the target and command**: a Docket ID authorizes \`docket task start <ID> --json\`. Resolve an unambiguous tracked-item reference to its ID, then use the same named command. Only explicit next-Docket-task or backlog-selection language authorizes bare \`docket task start --json\`. If an apparent tracked reference remains ambiguous, perform only focused resolution or ask for clarification; never omit the ID, substitute the top ready item, or mutate \`.docket/active-task\`. A closed item needs explicit user intent to reopen, not merely its ID or a failed start. Before changing its status, resolve any different active task under step 3 and work in the authorized checkout; then check that its type is enabled by \`workflow.reopen_closed\` in \`docket.yaml\`, run \`docket task move <ID> todo --note "<reason>"\`, and proceed with the named start.
2. **Start through the engine**: run only the command authorized in step 1. If it succeeds, continue at step 4. If it fails for a reason other than \`active-task-conflict\`, stop; do not rename the session or begin tracked work. A conflict response is a refusal and a set of suggestions, not authority to clear the current marker or create a worktree.
3. **Resolve an active-task conflict**: keep the active and requested IDs distinct. Do not rename, begin tracked work, run \`docket task stop\`, create a branch or worktree, or change the original checkout merely because the requested task was authorized. An explicitly authorized serialized hand-off may run \`docket task stop\` followed by the named start in this checkout. For parallel tracked work, check project branch guidance and the response's task-file, starting-point, path and branch issues; do not silently commit or transfer another writer's uncommitted files. Present a concrete usable worktree path, distinct branch, starting commit containing the requested task and relevant guidance, and later integration step. By default, ask a direct question that names the action: “May I create a linked Git worktree at <path> on branch <branch> from commit <commit>, then start <requested-ID> there?” State that the original checkout stays active and integration is a later step. Do not substitute a vague approval or confirmation request. Wait for the user's answer; declining or not answering leaves both checkout and branch/worktree inventory unchanged. An applicable explicit request or session instruction, or a scoped automatic-isolation preference saved in existing project guidance at the user's request, already supplies isolation authority; report the chosen checkout and branch and proceed without asking again. Missing, ambiguous or revoked authority requires the same direct question. One-time approval does not save a preference; installation or upgrade never enables one. Isolation authority permits only creating the separate linked worktree and starting the requested task there, not stopping the original task, integrating, or cleaning up. Use \`git worktree add\`, never a Docket-owned worktree command; then target every shell, file and MCP operation at the new checkout and run \`docket task start <requested-ID> --json\` there. Changing shell directory alone does not retarget an existing MCP server rooted in the original checkout. On successful start there, continue at step 4; on failure, stop without touching the original marker.
4. **Use the returned title intent**: read \`suggestedSessionTitle\` from the successful structured result. Do not rebuild it from prompt text or separately queried task fields.
5. **Preserve a retained epic-manager identity**: inspect the available calling-session context before applying the task-title intent. If this session previously established a retained \`Epic <ID> — <title>\` manager identity through the epic workflow, keep that title and skip the task rename. A later pickup does not clear the manager identity merely because the task belongs to the same epic, a different epic, or no epic. Only an explicit user request to repurpose this session for the picked task permits its task-title intent to replace the retained manager identity; a newly supervised epic replaces it through the epic workflow.
6. **Best-effort rename otherwise**: when no retained epic-manager identity takes precedence, ask the current harness's native adapter to name the calling session with the exact \`suggestedSessionTitle\`. If the host has no current-session naming capability, the capability is unavailable, or the rename fails, continue silently without retrying or treating pickup as failed.
7. **Hand off context**: use the returned task, epic, dependency, linked-concept, and commit fields as the context packet, then read its project-guidance source and relevant scoped links before planning or implementing the requested tracked work. Follow any source continuation cursor. An invalid or unavailable required source is a reported blocker, not permission to invent or weaken a standard.

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
2. Derive one manager title from those authoritative epic fields, exactly \`Epic <ID> — <title>\`, and establish it as the calling session's retained manager identity. Keep that identity for the lifetime of the session, including after epic completion or a blocker receipt, so later task pickups cannot replace it. Another explicitly supervised epic replaces it with that epic's manager identity; an explicit user request may rename, clear, or repurpose the session. Merely starting or resuming another task is not such a request. Ask the current harness's native adapter to apply the manager title. Unsupported, unavailable, or failed rename capability is a silent no-op; it never blocks supervision.
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

Return only after verified epic closure or a concrete blocker. Before returning, ask the native adapter to reapply the retained manager title once so the calling session ends on the epic rather than incidental child work; do not release that retained identity when the workflow returns. Unsupported or failed rename remains a silent no-op. A completion receipt names the epic, integrated child and epic commits, verification performed, serial-versus-parallel choice and why, interventions or conflicts, and any deliberately deferred follow-up. A blocker receipt names the exact failing child or epic criterion, dependency/decision/error, last accepted manager commit, preserved worker refs or worktrees, current Docket state, checks already attempted, and the single action needed to resume.

Do not create an orchestration database, scheduler, permanent runner, or synthetic epic status. On interruption, restart this workflow from section 1: Docket and Git reveal completed children and the next authoritative ready set; absent native lifecycle state simply selects the serial fallback.`,
  },
  {
    slug: "docket-task",
    title: "Create a work item",
    intent: "task-management",
    description:
      "Create a task, epic, or decision as a conformant OKF concept file — ID generation, template, links, index update.",
    body: `Create the explicitly requested Task, Epic or Decision as a conformant concept. Read project guidance before acting. Creating a concept never starts tracked work or activates project guidance; those require their own explicit requests and workflows.

**Choose the right kind**: a standalone Task is complete planning for a bounded change. Add an Epic when several tasks serve one outcome; add a Spec when intended behavior helps. Record a Decision only for an actual accepted choice, including the alternatives considered and consequences. Capture observations and ordinary knowledge through [wiki authoring](/workflows/docket-wiki.md); do not manufacture a decision or a project standard.

1. **Create through the engine**. Tasks and Epics use \`docket task create --type Task --title "…" --description "…" --priority p2 --json\` or MCP \`task_create\` (\`type: "Task"\` or \`"Epic"\`). Preserve explicit epic/dependency links; omit them for standalone work. These share the project sequence and start at \`todo\` under \`work/tasks/\` or \`work/epics/\`. Other type values fail; \`--type Decision\` is not a Decision path.
2. **For a Decision**, use \`docket decision create --title "…" --description "…" --context "Context, links and alternatives considered" --decision "The accepted choice and why" --consequences "Tradeoffs and effects" --json\` or MCP \`decision_create\` with the same fields (optional \`tags\`). It writes \`type: Decision\`, \`status: accepted\`, timestamp and the configured \`ids.decision_prefix\` (default \`DEC\`) under \`decisions/\`, with Context, Decision and Consequences sections. Omitted sections get placeholders that must be completed before reporting the record finished. Distinct decision/project prefixes have independent sequences; if configured identically they share the occupied ID namespace, so neither kind nor an alias can reuse an identity.
3. **Complete and link the source**. Task/Epic bodies need real Context links and verifiable Acceptance Criteria. Decision bodies need the actual choice, alternatives, rationale and consequences, with bundle-absolute links where relevant. Use \`docket document read <path> --json\` / MCP \`document_read\` for the complete source and version, then \`docket document edit <path> --input <file> --json\` / MCP \`document_edit\` with \`{expectedVersion, patch: {body}}\`. Do not replace complete bodies with paged excerpts. On conflict reread and reconcile before retrying. Never hand-allocate an ID or overwrite an occupied destination; linked-worktree coordination reserves current IDs and aliases. An engine missing these operations needs an explicit upgrade before writing.
4. **Refresh discovery and validate** with \`docket index\` / MCP \`index\`, then \`docket lint --json\` / MCP \`lint\`; review new errors and prose warnings. Read back the result and report its ID, path and any unresolved validation. Add a log entry when notable. Do not commit unless requested or already authorized by the surrounding workflow.
5. **Pickup is separate**. If the user also asked to begin a Task/Epic, follow [pickup](/workflows/docket-pickup.md). A Decision is a record, not tracked work; leave any unrelated active task untouched. Recording a choice does not activate a standard: separately requested guidance changes follow [guidance management](/workflows/docket-guidance.md).

Example: after an explicit choice of local Markdown over a hosted database, \`docket decision create --title "Store knowledge as Markdown" --context "Considered local Markdown and a hosted database." --decision "Use Markdown so changes are reviewable in Git." --consequences "Git provides history; collaborative editing needs conflict handling." --json\`, followed by \`docket index\` and \`docket lint --json\`, records that choice without creating a task or changing guidance.`,
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
   - Validate declared relationships, but do not flag a missing \`spec\` or \`epic\` alone: standalone tasks and spec-less epics are supported. Suggest optional grouping only when it serves a concrete user need.
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
3. **Reconcile the docs** (the LLM-first step): from the task diff and terminal narrative, identify wiki concepts (\`specs/\`, \`reference/\`, \`decisions/\`, plan documents) the conclusion invalidates or extends. Update them now. Distinguish descriptive implementation facts from chosen project standards in the guidance entry point and its linked sources. A GraphQL requirement violated by REST code is a discrepancy to report or fix within authorized scope, not permission to rewrite the requirement to accept REST. Preserve requirements, preferences and readable scope; revise or retire a standard only under explicit user authority, recording the reason and successor if any. Removing an active link never deletes its shared source. Report broken explicit links or unresolved conflicts instead of inventing missing instructions. If a choice foreclosed alternatives, record it as a \`type: Decision\` concept and link it from the Outcome or Disposition.
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
3. **Rotate a deep read**: pick the 1–2 concepts in \`specs/\` and \`reference/\` with the oldest last-modified commit and verify their content against current reality (code, plan). This catches drift that has no local commit at all — don't skip it just because the commit range is clean. Distinguish descriptive implementation facts from chosen project standards in the guidance entry point and its linked sources. A GraphQL requirement violated by REST code is a discrepancy to report or fix within authorized scope, not permission to rewrite the requirement to accept REST. Preserve requirements, preferences and readable scope; revise or retire a standard only under explicit user authority, recording the reason and successor if any. Removing an active link never deletes its shared source. Report broken explicit links or unresolved conflicts instead of inventing missing instructions.
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

export const DOCKET_WORKFLOWS: readonly WorkflowDef[] =
  WORKFLOW_DEFINITIONS.map((workflow) => ({
    ...workflow,
    body: `${workflow.body}\n\n**Writing** — ${MARKDOWN_AUTHORING_RULE}`,
  }));

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

**Engine** — the \`docket\` CLI is the write path: \`ready\`, \`overview\`, \`search\`, \`task list|create|start|stop|move|edit|close|log\`, \`lint\`, \`index\`, \`upgrade\`. Use \`--json\` on commands that advertise it; \`index\` and \`task stop\` currently return human output. Use the CLI for mechanics; never hand-edit status fields or the generated \`index.md\` body.

**Writing** — ${MARKDOWN_AUTHORING_RULE}

**Orientation** — for “what's next,” status, orientation, or an ordinary review, run \`${orientation.defaultEntrypoint.value}\`. This path is read-only and bounded: start with its structured result, follow bundle links only when the requested explanation needs more evidence, and do not start a task, regenerate the index, invoke a mutating workflow, or search unrelated implementation and fixture content when the overview is sufficient. Native skills are optional: without one, run the CLI command directly; an MCP-only client calls the read-only \`overview\` tool, which returns the same model and selection.

**Project guidance** — before planning or acting on direct or tracked implementation work, read optional \`${dir}${PROJECT_GUIDANCE_PATH}\` (or \`docket guidance --json\`; MCP: \`project_guidance\`). Follow source continuation pages, then read only the linked procedures relevant to the request using file reads or \`docket source <path> --json\` / MCP \`source_page\`. Scope is authored prose: apply API/testing standards to relevant implementation; deployment procedures only to deployment-related work, and execute them only when the user requested that activity. Absence is valid and creates no setup requirement. Invalid, unreadable or contradictory required guidance must be exposed; follow explicit user direction and applicable host/repository instruction precedence without silently weakening a standard. This read path never authorizes task creation, selection, pickup, stopping, or reading/adopting/clearing unrelated active-task state. Re-read after explicit guidance changes or at the next work boundary; Docket supplies source and instructions, not deterministic enforcement or instant updates to an already-running agent.

**Workflow extensions** — when a requested workflow matches installed project content, read \`docket extension list --json\` (MCP: \`workflow_extensions\`) and resolve the exact \`<package-id>:<workflow-id>\`; ambiguous titles require resolution. Before every relevant invocation or continuation, require current availability, read \`docket extension show <package-id> --json\` or the same MCP reader for effective choices with default/project ownership and tool bindings, then read the current canonical source, package guidance and relevant linked templates/procedures through file reads or \`docket source <path> --json\` / MCP \`source_page\`, following continuations. Package guidance applies within that workflow; defaults cannot weaken project requirements. Surface material contradictions under user/host/repository precedence. Installation, discovery and proposal preparation do not authorize task creation/pickup, unrelated procedure execution or external actions. Missing, disabled, removed, incompatible, invalid, review-required or pending-recovery content is unavailable. Generated pointers are snapshots; an already-running session must reread current state and may need a new session to discover newly installed native skills. An absent registry is an empty optional feature.

**Workflows** — the judgment procedures live in the bundle; read the file and follow it:

${list}

**Direct and tracked work** — a concrete direct request proceeds in the user's stated scope without creating, starting, selecting, or adopting Docket work; generic implementation language is not pickup authority. Use the \`docket-pickup\` workflow only when the user supplies a Docket ID, an unambiguous reference to an existing tracked item, or an explicit request to select the next Docket/backlog item. Resolve a tracked reference to its ID before starting it. If the reference remains ambiguous, perform a focused resolution or ask for clarification; never fall back to an unrelated top-ready item. Bare \`docket task start --json\` is permitted only for explicit next-Docket-task or backlog selection. Once pickup is authorized, the engine sets \`.docket/active-task\`, moves the selected task to \`in-progress\`, and returns the context packet plus one canonical \`suggestedSessionTitle\`; an installed native adapter may apply that title to the calling session on a best-effort basis. A retained epic-manager identity takes precedence over later task-title intents until the user explicitly repurposes the session or another epic is supervised. Unsupported hosts continue normally. Pause tracked work with \`docket task stop\` (clears the active task, status stays); conclude through \`docket task close\` + the close workflow. The command completes to \`done\` by default; \`--without-completion --note "<reason>"\` explicitly records \`closed\` instead.

**Epic supervision** — when the user explicitly asks to run or supervise a named epic through completion, follow the \`docket-epic\` workflow. Its \`Epic <ID> — <title>\` manager identity remains sticky for that calling session after completion or a blocker; later task pickups do not replace it unless the user explicitly repurposes the session, while another supervised epic establishes its own identity. Native worker, wait/follow-up, notification, and isolated-checkout bindings are optional; without a verified binding, execute its mandatory serial path in the calling session. Docket files and task-linked Git history remain authoritative across interruption.
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
