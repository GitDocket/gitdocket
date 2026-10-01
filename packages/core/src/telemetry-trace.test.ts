import { expect, test } from "bun:test";
import { analyzeDocketTrace, renderDocketTrace } from "./telemetry-trace";

const command = (text: string, extra = {}) => ({
  type: "commandExecution",
  command: text,
  cwd: "/private/project",
  exitCode: 0,
  ...extra,
});
const trace = (items: unknown[], extra = {}) =>
  JSON.stringify({
    schemaVersion: 1,
    page: { hasMore: false },
    turns: [{ startedAt: 1, items }],
    ...extra,
  });

test("lint review covers edit batches, code continuations, later edits and lost context without inferring redundancy", () => {
  const cases = [
    {
      name: "bundle batch and code-only continuation",
      items: [
        command("docket document edit reference/a.md --input private.json"),
        command("docket document edit reference/b.md --input private.json"),
        command("docket index; docket lint --json"),
        command("cp new.py app.py"),
      ],
      calls: 1,
      groups: 0,
    },
    {
      name: "later bundle edit requires another validation",
      items: [
        command("docket lint --json"),
        command("docket document edit reference/a.md --input private.json"),
        command("docket index; docket lint --json"),
      ],
      calls: 2,
      groups: 1,
    },
    {
      name: "closure log and state before final validation",
      items: [
        command("docket task close PRIVATE_ID --note PRIVATE_NOTE"),
        command("cp private-log.md docket/log.md"),
        command("docket index; docket lint --json"),
      ],
      calls: 1,
      groups: 0,
    },
    {
      name: "compaction with retained applicable evidence",
      items: [command("docket lint --json"), { type: "contextCompaction" }],
      calls: 1,
      groups: 0,
    },
    {
      name: "lost evidence after compaction requires revalidation",
      items: [
        command("docket lint --json"),
        { type: "contextCompaction" },
        command("docket lint --json"),
      ],
      calls: 2,
      groups: 1,
    },
  ];
  for (const fixture of cases) {
    const report = analyzeDocketTrace(trace(fixture.items));
    expect(report.lintReview.calls, fixture.name).toBe(fixture.calls);
    expect(report.lintReview.repetitionGroups, fixture.name).toHaveLength(
      fixture.groups,
    );
    expect(report.lintReview.inputEquality).toBe("unknown");
    expect(report.lintReview.mutationCoverage).toBe("unavailable");
    expect(renderDocketTrace(report)).toContain("Input equality unknown");
    expect(JSON.stringify(report)).not.toMatch(
      /PRIVATE|private-log|private.json/,
    );
  }
  expect(
    analyzeDocketTrace(trace(cases.at(-1)?.items ?? [])).lintReview
      .repetitionGroups[0]?.contextAvailability,
  ).toBe("compaction_observed_between_calls");
});

test("lint summary groups CLI/MCP calls together, excludes help and stays visible beyond the generic candidate cap", () => {
  const items = Array.from({ length: 31 }, (_, i) =>
    Array.from({ length: 4 }, () =>
      command(`cat docket/workflows/page${i}.md`),
    ),
  ).flat();
  const report = analyzeDocketTrace(
    trace([
      ...items,
      command("docket lint --help"),
      command("docket lint --json; docket lint --json"),
      {
        type: "mcpToolCall",
        server: "docket",
        tool: "lint",
        status: "completed",
      },
    ]),
  );
  expect(report.lintReview.calls).toBe(2);
  expect(report.candidates.some((c) => c.family === "lint")).toBe(false);
  expect(report.lintReview.repetitionGroups[0]).toMatchObject({
    calls: 2,
    n: 3,
    surfaces: ["cli", "mcp"],
  });
  expect(renderDocketTrace(report)).toContain("Lint investigation: 2 calls");
  const many = analyzeDocketTrace(
    trace([], {
      turns: Array.from({ length: 33 }, (_, startedAt) => ({
        startedAt,
        items: [command("docket lint"), command("docket lint")],
      })),
    }),
  );
  expect(many.lintReview.repetitionGroups).toHaveLength(30);
  expect(many.lintReview.omittedGroups).toBe(3);
});

test("five reported reads expose same-turn repetition separately from the routing adapter", () => {
  const input = trace([], {
    turns: [
      {
        startedAt: 2,
        items: [
          command(`sed -n '1,170p' docket/workflows/docket-close.md`),
          command(`sed -n '1,100p' .agents/skills/docket-close/SKILL.md`),
        ],
      },
      {
        startedAt: 1,
        items: [
          command(
            `cat docket/workflows/docket-pickup.md; cat docket/workflows/docket-close.md`,
          ),
          command(`sed -n '1,160p' .agents/skills/docket-close/SKILL.md`),
          command(`cat docket/workflows/docket-close.md`),
        ],
      },
    ],
  });
  const report = analyzeDocketTrace(input);
  expect(
    report.sequence.filter((e) => e.family === "workflow_read"),
  ).toHaveLength(4); // includes pickup
  expect(
    report.sequence.filter((e) => e.family === "adapter_read"),
  ).toHaveLength(2);
  expect(report.candidates).toHaveLength(1);
  expect(report.candidates[0]).toMatchObject({
    kind: "possible_repeated_read",
    n: 2,
    sourceEquality: "unknown",
    contextAvailability: "unknown",
  });
  expect(report.candidates[0]?.evidence[0]).toStartWith("turn:2/item:1/");
  expect(report.sequence[0]?.resource).not.toBe(
    analyzeDocketTrace(input).sequence[0]?.resource,
  );
});

test("literal launchers, nested shell calls, MCP provenance and compound calls", () => {
  const report = analyzeDocketTrace(
    trace([
      command(
        `/bin/zsh -lc 'bun run docket task list --json; docket index; npm run docket -- lint'`,
        { durationMs: 200 },
      ),
      command(`bun packages/cli/src/index.ts overview --json`),
      command(`/usr/local/bin/docket lint --help`),
      {
        type: "mcpToolCall",
        server: "docket",
        tool: "overview",
        status: "completed",
        durationMs: 12,
      },
      {
        type: "mcpToolCall",
        server: "other",
        tool: "overview",
        status: "completed",
      },
      command(`echo 'docket lint'`),
      command(`python3 -c 'print("docket index")'`),
    ]),
  );
  expect(report.sequence.map((m) => m.family)).toEqual([
    "task list",
    "index",
    "lint",
    "overview",
    "lint help",
    "overview",
  ]);
  expect(report.sequence.slice(0, 3).map((m) => m.durationMs)).toEqual([
    null,
    null,
    null,
  ]);
  expect(report.sequence.at(-1)?.durationMs).toBe(12);
  expect(report.coverage.unsupportedTools).toBe(1);
});

test("source changes and compaction never become proven waste or same-source claims", () => {
  const report = analyzeDocketTrace(
    trace([
      command("cat docket/workflows/docket-close.md", {
        output: { text: "OLD CONTENT" },
      }),
      command("cp replacement docket/workflows/docket-close.md"),
      { type: "contextCompaction" },
      command("cat docket/workflows/docket-close.md", {
        output: { text: "NEW CONTENT" },
      }),
    ]),
  );
  expect(report.candidates[0]).toMatchObject({
    sourceEquality: "unknown",
    contextAvailability: "compaction_observed_between_calls",
  });
  expect(JSON.stringify(report)).not.toMatch(
    /OLD CONTENT|NEW CONTENT|\/private|docket-close/,
  );
});

test("untrusted commands, contents, paths, errors and IDs cannot leak into output", () => {
  const report = analyzeDocketTrace(
    trace([
      command(`docket search SECRET_TITLE --json`, {
        output: { text: "SECRET_BODY" },
        error: "SECRET_ERROR",
        id: "SECRET_ID",
      }),
      command(`docket search SECRET_OTHER`, { exitCode: 1 }),
      command(`docket index`),
      command(`docket index`),
      command(`docket task start SECRET_TASK`),
      command(`docket task start SECRET_TASK`),
      command(`cat <<'END'\ndocket lint\nEND`),
      command(`docket source "$PRIVATE_PATH"`),
      command(`cat docket/workflows/*.md`),
      command(`sed -i 's/foo/bar/' docket/workflows/docket-close.md`),
    ]),
  );
  expect(JSON.stringify(report)).not.toMatch(
    /SECRET|PRIVATE_PATH|private\/project/,
  );
  expect(report.candidates.map((c) => c.kind)).toEqual([
    "possible_retry",
    "repeated_command_family",
    "lifecycle_churn",
  ]);
  expect(report.coverage.skippedShell).toBe(2);
});

test("bounded exports reject unsupported formats and expose omissions", () => {
  expect(() => analyzeDocketTrace("bad")).toThrow("read_thread");
  expect(() => analyzeDocketTrace("{}")).toThrow("unsupported trace");
  expect(() => analyzeDocketTrace(" ".repeat(8 * 1024 * 1024 + 1))).toThrow(
    "8 MiB",
  );
  const report = analyzeDocketTrace(
    trace(
      Array.from({ length: 10003 }, () => command("docket lint")),
      { page: { hasMore: true } },
    ),
  );
  expect(report.coverage.itemsInspected).toBe(10000);
  expect(report.coverage.omitted).toBe(3);
  expect(report.coverage.hasMore).toBe(true);
  expect(report.sequence).toHaveLength(200);
  expect(report.candidates[0]?.evidence).toHaveLength(20);
});

test("redirection targets and script strings are not interpreted as commands", () => {
  const report = analyzeDocketTrace(
    trace([
      command("docket overview --json > /tmp/report.json 2>&1; docket lint"),
      command("echo hello > docket lint"),
      command("cat docket/workflows/docket-close.md > /tmp/copy"),
    ]),
  );
  expect(report.sequence.map((m) => m.family)).toEqual([
    "overview",
    "lint",
    "workflow_read",
  ]);
});

test("duplicate export pages cannot inflate suspicious repetition", () => {
  const items = [
    command("docket lint", { id: "call-1" }),
    command("docket lint", { id: "call-1" }),
  ];
  expect(() => analyzeDocketTrace(trace(items))).toThrow(
    "duplicate trace items",
  );
  expect(() =>
    analyzeDocketTrace(
      trace([], {
        turns: [
          { id: "turn-1", items: [] },
          { id: "turn-1", items: [] },
        ],
      }),
    ),
  ).toThrow("duplicate trace turns");
});

test("source/document readers are associated with workflow reads", () => {
  const report = analyzeDocketTrace(
    trace([
      command("docket source workflows/docket-close.md --json"),
      command("docket document read /workflows/docket-close.md --json"),
      {
        type: "mcpToolCall",
        server: "docket",
        tool: "source_page",
        arguments: { path: "workflows/docket-close.md" },
        cwd: "/private/project",
        status: "completed",
      },
    ]),
  );
  expect(report.sequence.map((m) => m.family)).toEqual([
    "source",
    "workflow_read",
    "document read",
    "workflow_read",
    "source_page",
    "workflow_read",
  ]);
  expect(
    report.sequence
      .filter((m) => m.family === "workflow_read")
      .map((m) => m.resource)
      .every((id) => id === report.sequence[1]?.resource),
  ).toBe(true);
});

test("explicit caller lint-input evidence refines equality without claiming mutation coverage", () => {
  const v = "a".repeat(64),
    changed = "b".repeat(64);
  const annotated = (lintInputVersion: string) =>
    command("docket lint --json", {
      docketContext: {
        schema: "docket-context-observation/v1",
        lintInputVersion,
      },
    });
  const same = analyzeDocketTrace(trace([annotated(v), annotated(v)]));
  expect(same.lintReview.inputEquality).toBe("same-version-evidence");
  expect(renderDocketTrace(same)).toContain(
    "Input equality same-version-evidence",
  );
  expect(same.lintReview.mutationCoverage).toBe("unavailable");
  expect(
    analyzeDocketTrace(trace([annotated(v), annotated(changed)])).lintReview
      .inputEquality,
  ).toBe("changed-version-evidence");
  expect(
    analyzeDocketTrace(trace([annotated(v), command("docket lint --json")]))
      .lintReview.inputEquality,
  ).toBe("unknown");
  expect(JSON.stringify(same)).not.toContain(v);
});

test("compound lint calls contribute all input versions even when index is the first match", () => {
  const annotated = (version: string) =>
    command("docket index; docket lint --json", {
      docketContext: {
        schema: "docket-context-observation/v1",
        lintInputVersion: version,
      },
    });
  const report = analyzeDocketTrace(
    trace([annotated("a".repeat(64)), annotated("b".repeat(64))]),
  );
  expect(report.lintReview.calls).toBe(2);
  expect(report.lintReview.inputEquality).toBe("changed-version-evidence");
});
