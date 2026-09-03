import { describe, expect, test } from "bun:test";
import { parseConfig } from "./config";
import { parseConcept } from "./parse";
import { buildSchemas } from "./schema";

const schemas = buildSchemas(parseConfig());

const task = `---
type: Task
id: DKT-42
status: todo
depends_on: [DKT-7]
custom_field: kept
---

# Context

See [the spec](/specs/docket.md) and [OKF](https://okf.md/spec/).
`;

describe("parseConcept", () => {
  test("parses a task: typed frontmatter, defaults, unknown fields kept", () => {
    const { concept, diagnostics } = parseConcept(
      "work/tasks/DKT-42-x.md",
      task,
      schemas,
    );
    expect(diagnostics).toHaveLength(0);
    if (concept?.kind !== "work") throw new Error("expected work item");
    expect(concept.fm.id).toBe("DKT-42");
    expect(concept.fm.priority).toBe("p2"); // default
    expect(concept.fm.depends_on).toEqual(["DKT-7"]);
    expect(concept.fm.custom_field).toBe("kept"); // OKF: unknown fields preserved
  });

  test("extracts the link graph and classifies internal vs external", () => {
    const { concept } = parseConcept("work/tasks/DKT-42-x.md", task, schemas);
    expect(concept?.links).toEqual([
      { target: "/specs/docket.md", internal: true },
      { target: "https://okf.md/spec/", internal: false },
    ]);
  });

  test("retains conventional outcome and decision sections for derived summaries", () => {
    const work = parseConcept(
      "work/tasks/DKT-42-x.md",
      `${task}\n# Outcome\n\nA capability shipped.\n`,
      schemas,
    ).concept;
    expect(work?.kind === "work" && work.outcome).toBe("A capability shipped.");

    const choice = parseConcept(
      "decisions/DEC-1.md",
      "---\ntype: Decision\nid: DEC-1\n---\n\n# Context\n\nWhy.\n\n# Decision\n\nChoose this.\n\n# Consequences\n\nNow that.\n",
      schemas,
    ).concept;
    if (choice?.kind !== "decision") throw new Error("expected decision");
    expect({
      context: choice.context,
      decision: choice.decision,
      consequences: choice.consequences,
    }).toEqual({
      context: "Why.",
      decision: "Choose this.",
      consequences: "Now that.",
    });
  });

  test("unknown types are tolerated as generic concepts (OKF rule)", () => {
    const doc = `---\ntype: BigQuery Table\ntitle: events\n---\nbody`;
    const { concept, diagnostics } = parseConcept(
      "reference/events.md",
      doc,
      schemas,
    );
    expect(diagnostics).toHaveLength(0);
    expect(concept?.kind).toBe("generic");
  });

  test("missing frontmatter and missing type are errors", () => {
    expect(
      parseConcept("a.md", "# just markdown", schemas).diagnostics[0]?.message,
    ).toContain("missing YAML frontmatter");
    expect(
      parseConcept("a.md", "---\ntitle: no type\n---\n", schemas).diagnostics[0]
        ?.message,
    ).toContain("`type`");
  });

  test("invalid status and malformed id are schema errors", () => {
    const doc = `---\ntype: Task\nid: TASK-9x\nstatus: doing\n---\n`;
    const { diagnostics } = parseConcept("a.md", doc, schemas);
    const messages = diagnostics.map((d) => d.message).join("; ");
    expect(messages).toContain("id");
    expect(messages).toContain("status");
  });

  test("closed is a conformant terminal work-item status", () => {
    const doc = `---\ntype: Task\nid: DKT-9\nstatus: closed\n---\n`;
    const { concept, diagnostics } = parseConcept(
      "work/tasks/DKT-9-x.md",
      doc,
      schemas,
    );
    expect(diagnostics).toEqual([]);
    expect(concept?.kind === "work" && concept.fm.status).toBe("closed");
  });

  test("reserved filenames skip concept validation", () => {
    for (const path of ["index.md", "log.md", "overview.md"]) {
      const { concept, diagnostics } = parseConcept(
        path,
        "# no concept frontmatter",
        schemas,
      );
      expect(concept).toBeUndefined();
      expect(diagnostics).toHaveLength(0);
    }
  });
});
