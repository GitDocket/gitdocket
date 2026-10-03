import { describe, expect, test } from "bun:test";
import { parseConfig } from "./config";
import { ENGINE_SEMANTICS } from "./engine-semantics";
import { defaultConfigYaml } from "./init";
import { BUNDLE_VALIDATION_RULE } from "./markdown-prose";
import { parseConcept } from "./parse";
import { buildSchemas } from "./schema";
import { DOCKET_VERSION } from "./version";
import {
  ADAPTER_MARKER,
  composeManagedSection,
  DOCKET_WORKFLOWS,
  hasAdapterMarker,
  renderAgentSkillStub,
  renderClaudeSkillStub,
  renderDocketSection,
  renderWorkflow,
  validateWorkflowSemantics,
  workflowPath,
} from "./workflows";

const schemas = buildSchemas(parseConfig(defaultConfigYaml("ACME", "docs/")));

describe("renderWorkflow", () => {
  test("validation follows final authored edits and survives a handoff without claiming input equality", () => {
    for (const w of DOCKET_WORKFLOWS)
      expect(w.body).toContain(BUNDLE_VALIDATION_RULE);
    expect(renderDocketSection("ACME", "docs/")).toContain(
      BUNDLE_VALIDATION_RULE,
    );
    const close = DOCKET_WORKFLOWS.find((w) => w.slug === "docket-close");
    const task = DOCKET_WORKFLOWS.find((w) => w.slug === "docket-task");
    if (!close || !task) throw new Error("required workflow missing");
    const standalone = close.body
      .split("## Standalone closure")[1]
      ?.split("## Consolidated epic closure")[0];
    const consolidated = close.body.split("5. **Finalize once**")[1];
    if (!standalone || !consolidated) throw new Error("closure path missing");
    for (const body of [standalone, consolidated]) {
      const log = body.indexOf("`log.md` entry");
      const index = body.indexOf("`docket index`");
      const lint = body.indexOf("`docket lint --json`");
      expect(log).toBeGreaterThan(-1);
      expect(index).toBeGreaterThan(log);
      expect(lint).toBeGreaterThan(index);
      expect(body).toContain("subsequent bundle edit requires another");
    }
    const finalBatch = task.body
      .split("4. **Refresh discovery and validate the batch**")[1]
      ?.split("5. **Pickup is separate**")[0];
    if (!finalBatch) throw new Error("creation batch missing");
    expect(finalBatch.indexOf("log entry first")).toBeLessThan(
      finalBatch.indexOf("`docket index`"),
    );
    expect(finalBatch).toContain("do not refresh the derived index");
    expect(BUNDLE_VALIDATION_RULE).toContain("missing evidence");
    expect(BUNDLE_VALIDATION_RULE).toContain("validated input identity");
    expect(BUNDLE_VALIDATION_RULE).toContain("subsequent relevant changes");
    expect(BUNDLE_VALIDATION_RULE).toContain("verify its applicability");
    expect(BUNDLE_VALIDATION_RULE).toContain(
      "Preserve explicit project validation requirements",
    );
  });

  test("every workflow parses as a generic Workflow concept", () => {
    for (const w of DOCKET_WORKFLOWS) {
      const { concept, diagnostics } = parseConcept(
        workflowPath(w),
        renderWorkflow(w, "2026-07-21T00:00:00Z"),
        schemas,
      );
      expect(diagnostics).toEqual([]);
      expect(concept?.kind).toBe("generic");
      expect(concept?.fm.type).toBe("Workflow");
      expect(concept?.fm.title).toBe(w.title);
      expect(concept?.fm.origin).toBe(`${w.slug}@${DOCKET_VERSION}`);
    }
  });

  test("bodies are agent-neutral: no bun runner, no slash commands, no hardcoded project key", () => {
    for (const w of DOCKET_WORKFLOWS) {
      expect(w.body).not.toContain("bun run");
      expect(w.body).not.toMatch(/(^|[\s(])\/docket-/);
      expect(w.body).not.toContain("DKT-");
      expect(w.body).not.toContain("docs/specs");
      expect(w.body).not.toContain("codex_app__");
    }
  });

  test("pickup requires tracked-work authority before start, rename, and handoff", () => {
    const pickup = DOCKET_WORKFLOWS.find((w) => w.slug === "docket-pickup");
    if (!pickup) throw new Error("docket-pickup workflow missing");
    const authority = pickup.body.indexOf("Pickup authority requires");
    const resolve = pickup.body.indexOf("Resolve the target and command");
    const start = pickup.body.indexOf("Start or route through the engine");
    const preserve = pickup.body.indexOf(
      "Preserve a retained epic-manager identity",
    );
    const rename = pickup.body.indexOf("Best-effort rename");
    const handoff = pickup.body.indexOf("Hand off context");
    expect(authority).toBeGreaterThan(-1);
    expect(resolve).toBeGreaterThan(authority);
    expect(start).toBeGreaterThan(resolve);
    expect(preserve).toBeGreaterThan(start);
    expect(rename).toBeGreaterThan(preserve);
    expect(handoff).toBeGreaterThan(rename);
    expect(pickup.description).toContain("explicitly tracked Docket work only");
    expect(pickup.body).toContain("docket task start <ID> --compact --json");
    expect(pickup.body).toContain("requiredReads");
    expect(pickup.body).toContain("docket-pickup/v1");
    expect(pickup.body).toContain('outcome: "route"');
    expect(pickup.body).toContain('route.workflow: "docket-epic"');
    expect(pickup.body).toContain("stop another active task");
    expect(pickup.body).toContain(
      "Only explicit next-Docket-task or backlog-selection language authorizes bare",
    );
    expect(pickup.body).toContain("Generic implementation language does not");
    expect(pickup.body).toContain("direct request proceeds");
    expect(pickup.body).toContain("reference remains ambiguous");
    expect(pickup.body).toContain("never omit the ID");
    expect(pickup.body).toContain("substitute the top ready item");
    expect(pickup.body).toContain("mutate `.docket/active-task`");
    expect(pickup.body).toContain("suggestedSessionTitle");
    expect(pickup.body).toContain(
      "task belongs to the same epic, a different epic, or no epic",
    );
    expect(pickup.body).toContain(
      "explicit user request to repurpose this session for the picked task",
    );
    expect(pickup.body).toContain(
      "a newly supervised epic replaces it through the epic workflow",
    );
    expect(pickup.body).toContain("continue silently");
    expect(pickup.body).toContain("active-task-conflict");
    expect(pickup.body).toContain(
      "May I create a separate working copy and start <requested-ID> there?",
    );
    expect(pickup.body).toContain(
      "An applicable explicit request or session instruction",
    );
    expect(pickup.body).toContain(
      "declining or not answering leaves both checkout and branch/worktree inventory unchanged",
    );
    expect(pickup.body).toContain(
      "scoped automatic-isolation preference saved in existing project guidance at the user's request",
    );
    expect(pickup.body).toContain(
      "Missing, ambiguous or revoked authority, or a plan materially beyond its scope",
    );
    expect(pickup.body).toContain(
      "One-time approval does not save a preference",
    );
    expect(pickup.body).toContain(
      "Changing shell directory alone does not provide MCP target intent",
    );
    // These assertions qualify shipped instructions, not model compliance.
    const authorityCheck = pickup.body.indexOf("**Check authority first**");
    const overlapCheck = pickup.body.indexOf(
      "**Prepare a usable plan and inspect overlap**",
    );
    const approval = pickup.body.indexOf(
      "**Communicate the next action; ask only for missing authority**",
    );
    const isolation = pickup.body.indexOf(
      "**Isolate and target the new checkout**",
    );
    expect(authorityCheck).toBeGreaterThan(-1);
    expect(overlapCheck).toBeGreaterThan(authorityCheck);
    expect(approval).toBeGreaterThan(overlapCheck);
    expect(isolation).toBeGreaterThan(approval);
    expect(pickup.body).toContain(
      "Applicable host instructions may authorize routine reversible isolation",
    );
    expect(pickup.body).toContain(
      "a lower-priority confirmation default adds no new gate",
    );
    expect(pickup.body).toContain(
      "a worktree protects working files but does not resolve content ownership",
    );
    expect(pickup.body).toContain(
      "explicit ownership or reconciliation plan before the affected writes proceed",
    );
    expect(pickup.body).toContain(
      "defer those writes and continue authorized independent work",
    );
    expect(pickup.body).toContain("link the exact source once");
    expect(renderAgentSkillStub(pickup, "docket/")).toContain(
      "docket/workflows/docket-pickup.md",
    );
  });

  test("complete task creation supplies authored body once and reuses the returned version", () => {
    const task = DOCKET_WORKFLOWS.find((w) => w.slug === "docket-task");
    if (!task) throw new Error("Missing creation workflow");
    expect(task.body).toContain("task create --input <file> --compact --json");
    expect(task.body).toContain(
      "exclusively writes the final authored source once",
    );
    expect(task.body).toContain("needs no placeholder read/edit round trip");
    expect(task.body).toContain(
      "Skeleton routes still need real Context and Acceptance Criteria",
    );
    expect(task.body).toContain("creation never picks up work");
  });

  test("epic supervision fixes the preflight, serial fallback, integration, and receipt contract", () => {
    const epic = DOCKET_WORKFLOWS.find((w) => w.slug === "docket-epic");
    if (!epic) throw new Error("docket-epic workflow missing");

    const graph = epic.body.indexOf("Establish the authoritative graph");
    const preflight = epic.body.indexOf("Preflight isolation");
    const dispatch = epic.body.indexOf("Dispatch one bounded child contract");
    const integrate = epic.body.indexOf("Inspect and integrate one result");
    const close = epic.body.indexOf("Review and close the epic explicitly");
    const receipt = epic.body.indexOf("Return one consolidated receipt");
    expect(graph).toBeGreaterThan(-1);
    expect(preflight).toBeGreaterThan(graph);
    expect(dispatch).toBeGreaterThan(preflight);
    expect(integrate).toBeGreaterThan(dispatch);
    expect(close).toBeGreaterThan(integrate);
    expect(receipt).toBeGreaterThan(close);

    expect(epic.body).toContain(
      "docket task list --epic <EPIC-ID> --all --json",
    );
    const managerTitle = epic.body.indexOf("`Epic <ID> — <title>`");
    expect(managerTitle).toBeGreaterThan(graph);
    expect(managerTitle).toBeLessThan(preflight);
    expect(epic.body).toContain(
      "child pickup preserves the retained manager identity and makes no rename call",
    );
    expect(epic.body).toContain(
      "An isolated child session follows pickup normally and keeps its own",
    );
    expect(epic.body).toContain("returning does not require a rename call");
    expect(epic.body).toContain("lifetime of the session");
    expect(epic.body).toContain(
      "including after epic completion or a blocker receipt",
    );
    expect(epic.body).toContain(
      "Another explicitly supervised epic replaces it",
    );
    expect(epic.body).toContain(
      "Merely starting or resuming another task is not such a request",
    );
    expect(epic.body).toContain(
      "Do not release that retained identity when the workflow returns",
    );
    expect(epic.body).toContain("docket ready --json");
    expect(epic.body).toContain(ENGINE_SEMANTICS.readiness);
    expect(epic.body).toContain(ENGINE_SEMANTICS.readyOrdering);
    expect(epic.body).toContain("mandatory serial fallback");
    expect(epic.body).toContain("Never run concurrent writers in one checkout");
    expect(epic.body).toContain(
      "A child waiting on isolation approval or unresolved overlapping edits does not by itself block the epic",
    );
    expect(epic.body).toContain(
      "Continue one ready, authorized child whose write scope and reconciliation surfaces are independent",
    );
    expect(epic.body).toContain(
      "do not bypass dependencies, infer approval from silence",
    );
    expect(epic.body).toContain(
      "Return a blocker only when no ready, authorized child can progress safely",
    );
    expect(epic.body).toContain("Integrate one accepted commit series");
    expect(epic.body).toContain(
      "All children being done is necessary evidence, not epic completion",
    );
    expect(epic.body).toContain("Docket and Git reveal completed children");
    expect(epic.body).toContain("Do not create an orchestration database");
    expect(epic.body).toContain("synthetic epic status");
  });

  // docket:verifies DKT-272
  test("consolidated closure records acceptance before item judgment and finalizes once", () => {
    const close = DOCKET_WORKFLOWS.find((w) => w.slug === "docket-close")?.body;
    if (!close) throw new Error("close workflow missing");
    const batch = close.slice(close.indexOf("## Consolidated epic closure"));
    const steps = [
      "Record acceptance once",
      "Resolve each item's eligibility",
      "Write concise per-item outcomes and reconcile once",
      "Close through the CLI in dependency order",
      "Finalize once",
    ];
    let previous = -1;
    for (const step of steps) {
      const at = batch.indexOf(step);
      expect(at).toBeGreaterThan(previous);
      previous = at;
    }
    for (const rule of [
      "owner has accepted the results",
      "each explicit waiver by item ID, criterion and reason",
      "Each item references this shared record",
      "waived unobserved check remains unobserved, never passed",
      "Do not rerun passing tests without relevant changes or unresolved concerns",
      "verify every dependency resolves to `done`",
      "a waiver never changes dependency state",
      "Complete the epic last only when all children are `done`",
      "--without-completion",
      "retain unchecked unmet criteria",
      "the pass is not atomic",
      "skip already terminal items",
      "regenerate `docket index` once",
      "one `log.md` entry",
      "docket lint --json",
      "each item concluded in this pass",
      "leave an unrelated marker untouched",
    ])
      expect(batch).toContain(rule);
    expect(close).toContain("## Standalone closure");
    expect(batch).not.toContain("repeat the standalone");
  });

  test("epic preparation permits deferred closure without bypassing readiness or evidence", () => {
    const epic = DOCKET_WORKFLOWS.find((w) => w.slug === "docket-epic")?.body;
    if (!epic) throw new Error("epic workflow missing");
    expect(epic).toContain(
      "only acceptance or terminal moves remain, proceed to section 5",
    );
    expect(epic).toContain("leave the child nonterminal");
    expect(epic).toContain("pending-acceptance record");
    expect(epic).toContain("Deferred closure never makes a dependency ready");
    expect(epic).toContain("never bypass readiness to save a commit");
    expect(epic).toContain(
      "Implementation authorization alone is not owner acceptance",
    );
    expect(epic).toContain("Consolidated epic closure");
    expect(epic).toContain("do not reopen done children");
    expect(epic).toContain("Keep the user-facing receipt brief");
    expect(epic).not.toContain("Run final repository verification.");
    expect(epic).not.toContain("regenerate derived state with `docket index`");
  });

  test("grooming is discoverable only as an explicit hygiene audit", () => {
    const groom = DOCKET_WORKFLOWS.find((w) => w.slug === "docket-groom");
    if (!groom) throw new Error("docket-groom workflow missing");
    expect(groom.description).toContain("Full backlog hygiene audit");
    expect(groom.body).toContain("only when the user explicitly asks");
    expect(groom.body).toContain("docket overview --json");
  });

  test("workflow claims derive from the canonical engine semantics", () => {
    expect(validateWorkflowSemantics(DOCKET_WORKFLOWS)).toEqual([]);
    const groom = DOCKET_WORKFLOWS.find((w) => w.slug === "docket-groom");
    const standup = DOCKET_WORKFLOWS.find((w) => w.slug === "docket-standup");
    expect(groom?.body).toContain(ENGINE_SEMANTICS.readiness);
    expect(groom?.body).toContain(ENGINE_SEMANTICS.readyOrdering);
    expect(standup?.body).toContain(ENGINE_SEMANTICS.readyOrdering);
  });

  test("semantic validation rejects readiness, ordering, transition, and ownership drift", () => {
    const cases = [
      {
        slug: "docket-groom",
        claim: ENGINE_SEMANTICS.readiness,
        contradiction: "Ready is a stored status.",
        semantic: "readiness",
      },
      {
        slug: "docket-groom",
        claim: ENGINE_SEMANTICS.readyOrdering,
        contradiction: "The ready queue is ordered by dependency depth.",
        semantic: "ready-ordering",
      },
      {
        slug: "docket-pickup",
        claim: ENGINE_SEMANTICS.transitions,
        contradiction: "The workflow owns the status transition.",
        semantic: "state-transitions",
      },
      {
        slug: "docket-close",
        claim: ENGINE_SEMANTICS.mutationOwnership.close,
        contradiction: "The workflow owns every mutation.",
        semantic: "mutation-ownership",
      },
    ] as const;

    for (const example of cases) {
      const drifted = DOCKET_WORKFLOWS.map((workflow) => ({
        ...workflow,
        body:
          workflow.slug === example.slug
            ? workflow.body.replace(example.claim, example.contradiction)
            : workflow.body,
      }));
      expect(
        validateWorkflowSemantics(drifted).some(
          (diagnostic) =>
            diagnostic.slug === example.slug &&
            diagnostic.semantic === example.semantic,
        ),
      ).toBe(true);
    }
  });

  test("product-context refresh owns the structured checkpoint contract", () => {
    const context = DOCKET_WORKFLOWS.find(
      (w) => w.slug === "docket-state-of-play",
    );
    if (!context) throw new Error("docket-state-of-play workflow missing");
    expect(context.body).toContain("format: re-entry/v2");
    expect(context.body).toContain("## What we've done recently");
    expect(context.body).toContain("## What's up next");
    expect(context.body).toContain("## Worth knowing");
    expect(context.body).toContain("recent Outcomes");
    expect(context.body).toContain("Fourteen days".toLowerCase());
    expect(context.body).toContain("concrete nouns and consequences");
    expect(context.body).toContain("Earlier formats remain readable");
  });
});

describe("renderAgentSkillStub", () => {
  const taskWorkflow = DOCKET_WORKFLOWS.find((w) => w.slug === "docket-task");
  if (!taskWorkflow) throw new Error("docket-task workflow missing");

  test("carries the adapter marker and points at the bundle file", () => {
    const stub = renderAgentSkillStub(taskWorkflow, "docs/");
    expect(stub).toContain(ADAPTER_MARKER);
    expect(stub).toContain("docs/workflows/docket-task.md");
    expect(stub).toContain("name: docket-task");
  });

  test("normalizes a bundle dir without trailing slash", () => {
    const stub = renderAgentSkillStub(taskWorkflow, "notes");
    expect(stub).toContain("notes/workflows/docket-task.md");
  });

  test("marker carries the engine version; detection matches the pre-DKT-18 unversioned marker", () => {
    expect(ADAPTER_MARKER).toContain(`docket init@${DOCKET_VERSION}`);
    expect(hasAdapterMarker(renderClaudeSkillStub(taskWorkflow, "docs/"))).toBe(
      true,
    );
    expect(renderClaudeSkillStub(taskWorkflow, "docs/")).toBe(
      renderAgentSkillStub(taskWorkflow, "docs/"),
    );
    expect(
      hasAdapterMarker(
        "<!-- generated by docket init — edits are overwritten; the workflow in the bundle is the source of truth -->",
      ),
    ).toBe(true);
    expect(hasAdapterMarker("# my hand-authored skill")).toBe(false);
  });

  test("pickup adapters accept one bounded native binding and default to unsupported", () => {
    const pickup = DOCKET_WORKFLOWS.find((w) => w.slug === "docket-pickup");
    if (!pickup) throw new Error("docket-pickup workflow missing");

    const native = renderAgentSkillStub(
      pickup,
      "docs/",
      "Apply the exact native title operation.",
    );
    expect(native).toContain("explicitly tracked Docket work only");
    expect(native).toContain("direct work bypasses Docket");
    expect(native).toContain("ambiguous references require resolution");
    expect(native).toContain("Apply the exact native title operation.");

    const fallback = renderAgentSkillStub(pickup, "docs/");
    expect(fallback).toContain("rename unsupported");
    expect(fallback).toContain("without warning");
  });

  test("epic adapters accept one bounded lifecycle binding and default to serial", () => {
    const epic = DOCKET_WORKFLOWS.find((w) => w.slug === "docket-epic");
    if (!epic) throw new Error("docket-epic workflow missing");

    const native = renderAgentSkillStub(
      epic,
      "docs/",
      "Create one isolated native worker, then inspect durable evidence.",
    );
    expect(native).toContain("Native epic-supervision lifecycle binding");
    expect(native).toContain("Create one isolated native worker");

    const fallback = renderAgentSkillStub(epic, "docs/");
    expect(fallback).toContain("current-session rename unsupported");
    expect(fallback).toContain(
      "Skip manager-title application and restoration",
    );
    expect(fallback).toContain("no verified native worker lifecycle binding");
    expect(fallback).toContain("serially in the calling session");
    expect(fallback).toContain("do not infer worker creation");
  });
});

describe("composeManagedSection", () => {
  const section = renderDocketSection("ACME", "docs/");

  test("creates when missing, lists every workflow", () => {
    const result = composeManagedSection(undefined, section);
    expect(result.action).toBe("create");
    for (const w of DOCKET_WORKFLOWS)
      expect(result.content).toContain(workflowPath(w));
    expect(result.content).toContain("the `docket-pickup` workflow");
    expect(result.content).toContain("**Direct and tracked work**");
    expect(result.content).toContain("concrete direct request proceeds");
    expect(result.content).toContain("generic implementation language");
    expect(result.content).toContain("supplies a Docket ID");
    expect(result.content).toContain("unambiguous reference");
    expect(result.content).toContain("reference remains ambiguous");
    expect(result.content).toContain("never fall back");
    expect(result.content).toContain(
      "permitted only for explicit next-Docket-task or backlog selection",
    );
    expect(result.content).toContain("`suggestedSessionTitle`");
    expect(result.content).toContain(
      "A retained epic-manager identity takes precedence",
    );
    expect(result.content).toContain("Unsupported hosts continue normally");
    expect(result.content).toContain("**Epic supervision**");
    expect(result.content).toContain("the `docket-epic` workflow");
    expect(result.content).toContain(
      "manager identity remains sticky for that calling session",
    );
    expect(result.content).toContain("mandatory serial path");
    expect(result.content).toContain(
      "for “what's next,” status, orientation, or an ordinary review",
    );
    expect(result.content).toContain("`docket overview --json`");
    expect(result.content).toContain("do not start a task");
    expect(result.content).toContain("search unrelated implementation");
    expect(result.content).toContain("MCP-only client");
    expect(result.content).not.toContain("codex_app__");
  });

  test("appends to an existing file without markers", () => {
    const result = composeManagedSection("# My rules\n\nBe nice.", section);
    expect(result.action).toBe("update");
    expect(result.content.startsWith("# My rules\n\nBe nice.\n")).toBe(true);
    expect(result.content).toContain("## Docket");
  });

  test("regenerates only the marked span, then skips when unchanged", () => {
    const stale = composeManagedSection(
      `# Rules\n\n<!-- >>> docket@0.0.0 >>> -->\nold\n<!-- <<< docket <<< -->\n\n# After\n`,
      section,
    );
    expect(stale.action).toBe("update");
    expect(stale.content).not.toContain("old");
    expect(stale.content.startsWith("# Rules\n")).toBe(true);
    expect(stale.content).toContain("\n\n# After\n");

    const rerun = composeManagedSection(stale.content, section);
    expect(rerun.action).toBe("skip");
    expect(rerun.reason).toBe("up to date");
  });

  test("section marker carries the engine version and the pre-DKT-18 unversioned span still regenerates", () => {
    expect(section).toContain(`<!-- >>> docket@${DOCKET_VERSION} >>> -->`);
    const legacy = composeManagedSection(
      "<!-- >>> docket >>> -->\nold\n<!-- <<< docket <<< -->\n",
      section,
    );
    expect(legacy.action).toBe("update");
    expect(legacy.content).not.toContain("old");
    expect(legacy.content).toContain(`docket@${DOCKET_VERSION}`);
  });
});
