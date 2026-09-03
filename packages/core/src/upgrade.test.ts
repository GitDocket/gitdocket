import { describe, expect, test } from "bun:test";
import { composeHook, upgradeHookBlock } from "./init";
import { type ShippedHistory, shippedHistory } from "./shipped";
import LEDGER from "./shipped-history.json";
import {
  type Merge3,
  markerVersion,
  upgradeAdapter,
  upgradeWorkflowFile,
} from "./upgrade";
import { DOCKET_VERSION } from "./version";
import {
  DOCKET_WORKFLOWS,
  renderClaudeSkillStub,
  renderWorkflow,
} from "./workflows";

// Two shipped versions: 1.0.0 (old) and 2.0.0 (new). The body gains a line at
// the end, so a customization at the top merges cleanly and a customization
// of the last line conflicts.
const V1_BODY = "Step one.\n\nStep two.\n\nStep three.";
const V2_BODY = "Step one.\n\nStep two.\n\nStep three, improved.";
const HISTORY: ShippedHistory = [
  { version: "2.0.0", bodies: { "docket-task": V2_BODY } },
  { version: "1.0.0", bodies: { "docket-task": V1_BODY } },
];

// Deterministic fake merge: applies the base→theirs change when ours kept the
// changed region intact, conflicts otherwise. Enough to exercise the four
// outcomes without shelling out to git from core tests.
const merge3: Merge3 = (base, ours, theirs) => {
  if (ours === base) return { content: theirs, conflict: false };
  if (base === theirs) return { content: ours, conflict: false };
  const baseTail = "Step three.";
  const theirsTail = "Step three, improved.";
  if (ours.endsWith(baseTail)) {
    return {
      content: ours.slice(0, -baseTail.length) + theirsTail,
      conflict: false,
    };
  }
  return {
    content: `<<<<<<< ours\n${ours}\n=======\n${theirs}\n>>>>>>> theirs\n`,
    conflict: true,
  };
};

const file = (origin: string | undefined, body: string): string =>
  `---\ntype: Workflow\ntitle: T\n${origin ? `origin: ${origin}\n` : ""}tags: [docket, workflow]\ntimestamp: 2026-01-01T00:00:00Z\n---\n\n${body}\n`;

const opts = { merge3, history: HISTORY, current: "2.0.0" };

describe("upgradeWorkflowFile", () => {
  test("unmodified from origin → replaced, origin bumped, frontmatter otherwise untouched", () => {
    const result = upgradeWorkflowFile(
      file("docket-task@1.0.0", V1_BODY),
      opts,
    );
    expect(result.action).toBe("replaced");
    expect(result.from).toBe("1.0.0");
    expect(result.content).toContain("origin: docket-task@2.0.0");
    expect(result.content).toContain(V2_BODY);
    expect(result.content).toContain("timestamp: 2026-01-01T00:00:00Z");
  });

  test("already at current → up-to-date, no write", () => {
    const source = file("docket-task@2.0.0", V2_BODY);
    const result = upgradeWorkflowFile(source, opts);
    expect(result.action).toBe("up-to-date");
    expect(result.content).toBe(source);
  });

  test("diverged with nothing to propagate (base == theirs) → up-to-date, but says so", () => {
    const customized = `LOCAL RULE: always ask first.\n\n${V2_BODY}`;
    const result = upgradeWorkflowFile(
      file("docket-task@2.0.0", customized),
      opts,
    );
    expect(result.action).toBe("up-to-date");
    expect(result.reason).toContain("local text kept");
  });

  test("diverged in an untouched region → merged, customization survives", () => {
    const customized = `LOCAL RULE: always ask first.\n\n${V1_BODY}`;
    const result = upgradeWorkflowFile(
      file("docket-task@1.0.0", customized),
      opts,
    );
    expect(result.action).toBe("merged");
    expect(result.content).toContain("LOCAL RULE: always ask first.");
    expect(result.content).toContain("Step three, improved.");
    expect(result.content).toContain("origin: docket-task@2.0.0");
  });

  test("diverged in the changed region → conflict with markers, new origin stamped", () => {
    const clashing = V1_BODY.replace("Step three.", "Step three, but my way.");
    const result = upgradeWorkflowFile(
      file("docket-task@1.0.0", clashing),
      opts,
    );
    expect(result.action).toBe("conflict");
    expect(result.content).toContain("<<<<<<<");
    expect(result.content).toContain(">>>>>>>");
    expect(result.content).toContain("origin: docket-task@2.0.0");
  });

  test("un-stamped but unmodified → recovered and replaced, origin line inserted", () => {
    const result = upgradeWorkflowFile(file(undefined, V1_BODY), opts);
    expect(result.action).toBe("replaced");
    expect(result.content).toContain("origin: docket-task@2.0.0");
  });

  test("un-stamped and modified → skipped, origin unknowable", () => {
    const result = upgradeWorkflowFile(file(undefined, "my own thing"), opts);
    expect(result.action).toBe("skipped");
    expect(result.reason).toContain("origin unknown");
  });

  test("origin at a version with no shipped text → skipped", () => {
    const result = upgradeWorkflowFile(
      file("docket-task@9.9.9", V1_BODY),
      opts,
    );
    expect(result.action).toBe("skipped");
    expect(result.reason).toContain("no shipped text");
  });

  test("slug retired at current → skipped", () => {
    const history: ShippedHistory = [
      { version: "2.0.0", bodies: {} },
      { version: "1.0.0", bodies: { "docket-task": V1_BODY } },
    ];
    const result = upgradeWorkflowFile(file("docket-task@1.0.0", V1_BODY), {
      ...opts,
      history,
    });
    expect(result.action).toBe("skipped");
    expect(result.reason).toContain("not shipped at 2.0.0");
  });
});

describe("upgradeAdapter", () => {
  const w = DOCKET_WORKFLOWS[0];
  if (!w) throw new Error("no workflows");
  const generated = renderClaudeSkillStub(w, "docs/");

  test("marked and stale → regenerated", () => {
    const stale = generated.replace("docs/", "old-bundle/");
    const result = upgradeAdapter(stale, generated);
    expect(result.action).toBe("regenerated");
    expect(result.content).toBe(generated);
  });

  test("pre-DKT-18 unversioned marker → regenerated, no from-version", () => {
    const legacy = generated.replace(
      `docket init@${DOCKET_VERSION}`,
      "docket init",
    );
    const result = upgradeAdapter(legacy, generated);
    expect(result.action).toBe("regenerated");
    expect(result.from).toBeUndefined();
  });

  test("identical → up-to-date; hand-authored → skipped untouched", () => {
    expect(upgradeAdapter(generated, generated).action).toBe("up-to-date");
    const hand = upgradeAdapter("# my own skill\n", generated);
    expect(hand.action).toBe("skipped");
    expect(hand.content).toBe("# my own skill\n");
  });
});

describe("upgradeHookBlock", () => {
  test("regenerates a stale marked block in place, preserving surroundings", () => {
    const stale = `#!/bin/sh\nnpx lint-staged\n# >>> docket prepare-commit-msg >>>\nold body\n# <<< docket prepare-commit-msg <<<\ntail\n`;
    const result = upgradeHookBlock(stale);
    expect(result.action).toBe("update");
    expect(result.content).toContain("npx lint-staged");
    expect(result.content).toContain("tail");
    expect(result.content).not.toContain("old body");
    expect(result.content).toContain(
      `# >>> docket prepare-commit-msg@${DOCKET_VERSION} >>>`,
    );
  });

  test("current block → skip up to date; hand-rolled hook → skip untouched", () => {
    const current = composeHook(undefined).content;
    expect(upgradeHookBlock(current).reason).toBe("up to date");
    const hand = upgradeHookBlock("#!/bin/sh\ncat .docket/active-task\n");
    expect(hand.action).toBe("skip");
    expect(hand.reason).toContain("hand-rolled");
  });
});

describe("markerVersion", () => {
  test("reads the version from each marker kind, undefined when unversioned", () => {
    expect(markerVersion(`<!-- generated by docket init@1.2.3 — x -->`)).toBe(
      "1.2.3",
    );
    expect(markerVersion(`<!-- >>> docket@1.2.3 >>> -->`)).toBe("1.2.3");
    expect(markerVersion(`# >>> docket prepare-commit-msg@1.2.3 >>>`)).toBe(
      "1.2.3",
    );
    expect(markerVersion("<!-- >>> docket >>> -->")).toBeUndefined();
  });
});

describe("renderWorkflow round-trip", () => {
  test("a freshly scaffolded workflow is up-to-date under upgrade", () => {
    for (const w of DOCKET_WORKFLOWS) {
      const result = upgradeWorkflowFile(
        renderWorkflow(w, "2026-01-01T00:00:00Z"),
        { merge3 },
      );
      expect(result.action).toBe("up-to-date");
    }
  });
});

describe("continuous shipped-text correction", () => {
  test("0.0.1 groom guidance upgrades to the canonical claim and preserves customization", () => {
    const previous = LEDGER.find((entry) => entry.version === "0.0.1");
    const current = LEDGER.find((entry) => entry.version === DOCKET_VERSION);
    const oldBody = previous?.bodies["docket-groom"];
    const currentBody = current?.bodies["docket-groom"];
    if (!oldBody || !currentBody)
      throw new Error("expected 0.0.1 and current groom bodies in ledger");
    expect(oldBody).toContain("dependency depth");
    expect(currentBody).not.toContain("dependency depth");

    const history = shippedHistory();
    const preserveTrailingCustomization: Merge3 = (base, ours, theirs) => {
      if (ours === base) return { content: theirs, conflict: false };
      if (ours.startsWith(base)) {
        return {
          content: `${theirs}${ours.slice(base.length)}`,
          conflict: false,
        };
      }
      return { content: ours, conflict: true };
    };
    const options = {
      history,
      current: DOCKET_VERSION,
      merge3: preserveTrailingCustomization,
    };

    const clean = upgradeWorkflowFile(
      file("docket-groom@0.0.1", oldBody),
      options,
    );
    expect(clean.action).toBe("replaced");
    expect(clean.content).toContain(currentBody);
    expect(clean.content).toContain(`origin: docket-groom@${DOCKET_VERSION}`);

    const localRule = "LOCAL: keep our additional audit check.";
    const customized = upgradeWorkflowFile(
      file("docket-groom@0.0.1", `${oldBody}\n\n${localRule}`),
      options,
    );
    expect(customized.action).toBe("merged");
    expect(customized.content).toContain(currentBody);
    expect(customized.content).toContain(localRule);
    expect(customized.content).not.toContain("dependency depth");
  });

  test("0.0.1 pickup guidance upgrades to explicit authority and preserves customization", () => {
    const previous = LEDGER.find((entry) => entry.version === "0.0.1");
    const current = LEDGER.find((entry) => entry.version === DOCKET_VERSION);
    const oldBody = previous?.bodies["docket-pickup"];
    const currentBody = current?.bodies["docket-pickup"];
    if (!oldBody || !currentBody)
      throw new Error("expected 0.0.1 and current pickup bodies in ledger");
    expect(oldBody).toContain("top ready task when none is named");
    expect(currentBody).toContain("Pickup authority requires");
    expect(currentBody).toContain(
      "Only explicit next-Docket-task or backlog-selection",
    );

    const preserveTrailingCustomization: Merge3 = (base, ours, theirs) => {
      if (ours === base) return { content: theirs, conflict: false };
      if (ours.startsWith(base)) {
        return {
          content: `${theirs}${ours.slice(base.length)}`,
          conflict: false,
        };
      }
      return { content: ours, conflict: true };
    };
    const options = {
      history: shippedHistory(),
      current: DOCKET_VERSION,
      merge3: preserveTrailingCustomization,
    };

    const clean = upgradeWorkflowFile(
      file("docket-pickup@0.0.1", oldBody),
      options,
    );
    expect(clean.action).toBe("replaced");
    expect(clean.content).toContain(currentBody);

    const localRule = "LOCAL: retain our task-context preflight.";
    const customized = upgradeWorkflowFile(
      file("docket-pickup@0.0.1", `${oldBody}\n\n${localRule}`),
      options,
    );
    expect(customized.action).toBe("merged");
    expect(customized.content).toContain(currentBody);
    expect(customized.content).toContain(localRule);
    expect(customized.content).not.toContain(
      "top ready task when none is named",
    );
  });
});
