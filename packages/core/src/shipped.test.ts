import { describe, expect, test } from "bun:test";
import {
  formatOrigin,
  parseOrigin,
  recoverOrigin,
  shippedWorkflow,
} from "./shipped";
import LEDGER from "./shipped-history.json";
import { DOCKET_VERSION } from "./version";
import {
  DOCKET_WORKFLOWS,
  renderWorkflow,
  validateWorkflowSemantics,
} from "./workflows";

// Editing a DOCKET_WORKFLOWS body in place rewrites the
// 3-way-merge base under every copy vendored at the current version, so
// `docket upgrade` reports up-to-date while propagating nothing. The ledger
// head pins the last-synced texts; these tests fail until `bun run
// sync-shipped` has propagated the edit and refreshed the head. Procedure:
// docket/reference/releasing.md.
describe("shipped-history ledger", () => {
  test("head is the current version — after bumping DOCKET_VERSION, run `bun run sync-shipped`", () => {
    expect(LEDGER[0]?.version).toBe(DOCKET_VERSION);
  });

  test("head mirrors the live bodies — after editing a template, run `bun run sync-shipped`", () => {
    const liveBodies = Object.fromEntries(
      DOCKET_WORKFLOWS.map((w) => [w.slug, w.body]),
    );
    const head = LEDGER[0];
    const headBodies = Object.fromEntries(
      Object.entries(head?.bodies ?? {}).filter(
        (pair): pair is [string, string] => typeof pair[1] === "string",
      ),
    );
    expect(headBodies).toEqual(liveBodies);
  });

  test("head workflows satisfy the canonical engine semantic contract", () => {
    const head = LEDGER[0];
    const bodies = Object.entries(head?.bodies ?? {})
      .filter((pair): pair is [string, string] => typeof pair[1] === "string")
      .map(([slug, body]) => ({ slug, body }));
    expect(validateWorkflowSemantics(bodies)).toEqual([]);
  });

  test("versions are unique", () => {
    const versions = LEDGER.map((h) => h.version);
    expect(new Set(versions).size).toBe(versions.length);
  });
});

describe("origin format", () => {
  test("round-trips slug@version", () => {
    const origin = { slug: "docket-close", version: "0.0.1" };
    expect(parseOrigin(formatOrigin(origin))).toEqual(origin);
  });

  test("rejects malformed values", () => {
    expect(parseOrigin("docket-close")).toBeUndefined();
    expect(parseOrigin("docket-close@")).toBeUndefined();
    expect(parseOrigin("@0.0.1")).toBeUndefined();
    expect(parseOrigin("Docket-Close@0.0.1")).toBeUndefined();
  });
});

describe("shippedWorkflow", () => {
  test("current version resolves every workflow to its live body", () => {
    for (const w of DOCKET_WORKFLOWS) {
      expect(shippedWorkflow(w.slug, DOCKET_VERSION)).toBe(w.body);
    }
  });

  test("unknown slug or version → undefined", () => {
    expect(shippedWorkflow("docket-task", "99.0.0")).toBeUndefined();
    expect(shippedWorkflow("nope", DOCKET_VERSION)).toBeUndefined();
  });
});

describe("recoverOrigin", () => {
  test("recovers slug and version from an unmodified scaffolded file", () => {
    for (const w of DOCKET_WORKFLOWS) {
      const scaffolded = renderWorkflow(w, "2026-07-21T00:00:00Z");
      expect(recoverOrigin(scaffolded)).toEqual({
        slug: w.slug,
        version: DOCKET_VERSION,
      });
    }
  });

  test("frontmatter differences (timestamp, extra fields) don't block recovery", () => {
    const w = DOCKET_WORKFLOWS[0];
    if (!w) throw new Error("no workflows");
    const source = `---\ntype: Workflow\ntitle: Renamed\ntimestamp: 2020-01-01T00:00:00Z\n---\n\n${w.body}\n`;
    expect(recoverOrigin(source)?.slug).toBe(w.slug);
  });

  test("a modified body is unrecoverable", () => {
    const w = DOCKET_WORKFLOWS[0];
    if (!w) throw new Error("no workflows");
    const modified = renderWorkflow(w, "2026-07-21T00:00:00Z").replace(
      w.body.slice(0, 20),
      "Customized opening. ",
    );
    expect(recoverOrigin(modified)).toBeUndefined();
  });
});
