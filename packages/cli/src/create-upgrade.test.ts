import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DOCKET_VERSION,
  DOCKET_WORKFLOWS,
  renderWorkflow,
  shippedWorkflow,
} from "@gitdocket/core";
import { runUpgrade } from "./upgrade";

test("current creation instructions propagate from released workflows with dry-run, stricter rules, stale close adapters and repeat qualification", async () => {
  const temp = await mkdtemp(join(tmpdir(), "docket-create-upgrade-"));
  try {
    const old = shippedWorkflow("docket-task", "0.6.0");
    if (!old) throw new Error("Missing frozen released task workflow");
    const path = join(temp, "docket/workflows/docket-task.md");
    await mkdir(join(temp, "docket/workflows"), { recursive: true });
    await writeFile(
      join(temp, "docket.yaml"),
      "project: FIX\nbundle: docket\n",
    );
    const stricter =
      "Project rule: run the strict global link audit after authored changes.";
    const original = `---\ntype: Workflow\ntitle: Create tracked work\norigin: docket-task@0.6.0\ntags: [docket, workflow]\n---\n\n${old}\n\n${stricter}\n`;
    await writeFile(path, original);
    const stub = join(temp, ".agents/skills/docket-close/SKILL.md");
    await mkdir(join(stub, ".."), { recursive: true });
    await writeFile(
      stub,
      "---\nname: docket-close\ndescription: Close work\n---\n\n<!-- docket:agent-skill@0.6.0 -->\nRead docket/workflows/docket-close.md.\n",
    );
    await runUpgrade(temp, { dryRun: true });
    expect(await readFile(path, "utf8")).toBe(original);
    const report = await runUpgrade(temp, {});
    const current = await readFile(path, "utf8");
    expect(current).toContain("task create --input <file> --compact --json");
    expect(current).toContain("needs no placeholder read/edit round trip");
    expect(current).toContain(stricter);
    expect(current).toContain(`origin: docket-task@${DOCKET_VERSION}`);
    // The custom rule overlaps a changed released Writing tail: preserve both
    // and expose the conflict rather than silently weakening project policy.
    expect(
      report.items.find((item) =>
        item.path.endsWith("workflows/docket-task.md"),
      )?.action,
    ).toBe("conflict");
    expect(current).toContain("<<<<<<<");
    const task = DOCKET_WORKFLOWS.find((w) => w.slug === "docket-task");
    if (!task) throw new Error("Missing current task workflow");
    const reviewed = `${renderWorkflow(task, "2026-09-30T00:00:00Z").trimEnd()}\n\n${stricter}\n`;
    await writeFile(path, reviewed);
    await runUpgrade(temp, {});
    expect(await readFile(path, "utf8")).toBe(reviewed);
    // Known generated close retirement is qualified by the shared upgrade suite;
    // unfamiliar adapters remain available for explicit review, never overwritten.
    const unknown = await readFile(stub, "utf8").catch(() => null);
    if (unknown !== null)
      expect(unknown).toContain("Read docket/workflows/docket-close.md.");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
