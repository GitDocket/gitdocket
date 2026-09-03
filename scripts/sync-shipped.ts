// sync-shipped — keep the shipped-text ledger in step with the live templates.
// Editing a DOCKET_WORKFLOWS body in place rewrites the 3-way-merge
// base under every copy vendored at the current version, so `docket upgrade`
// reports up-to-date while propagating nothing. This script closes the loop
// after a template edit: it merges the edit into this repo's own vendored
// copies (base = the ledger's last-synced body), rewrites the ledger head to
// the live texts, and regenerates the adapters. On a DOCKET_VERSION bump it
// starts a new head entry — the old head is already the frozen record of the
// outgoing release, so there is no separate freeze step. The guard test in
// shipped.test.ts fails until this has run. See docket/reference/releasing.md.

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gitMerge3, runUpgrade } from "../packages/cli/src/upgrade";
import { parseConfig } from "../packages/core/src/config";
import { DOCKET_VERSION } from "../packages/core/src/version";
import {
  DOCKET_WORKFLOWS,
  WORKFLOWS_DIR,
} from "../packages/core/src/workflows";

interface LedgerEntry {
  version: string;
  bodies: Record<string, string>;
}

const root = join(import.meta.dir, "..");
const ledgerPath = join(root, "packages/core/src/shipped-history.json");

const live: Record<string, string> = Object.fromEntries(
  DOCKET_WORKFLOWS.map((w) => [w.slug, w.body]),
);

const changedSlugs = (base: Record<string, string>): string[] =>
  [...new Set([...Object.keys(live), ...Object.keys(base)])].filter(
    (slug) => live[slug]?.trim() !== base[slug]?.trim(),
  );

/** Merge changed templates into this repo's vendored copies; returns conflicted paths. */
async function propagate(base: Record<string, string>): Promise<string[]> {
  if (!existsSync(join(root, "docket.yaml"))) {
    console.log(
      "no canonical bundle in this checkout — refreshing the shipped ledger only",
    );
    return [];
  }
  const config = parseConfig(await readFile(join(root, "docket.yaml"), "utf8"));
  const conflicts: string[] = [];
  for (const slug of changedSlugs(base)) {
    const rel = join(config.bundle, WORKFLOWS_DIR, `${slug}.md`);
    const path = join(root, rel);
    const theirs = live[slug];
    const oldBase = base[slug];
    if (theirs === undefined) {
      if (existsSync(path))
        console.log(`~ ${rel}: template retired upstream — copy left alone`);
      continue;
    }
    if (oldBase === undefined || !existsSync(path)) {
      console.log(
        `~ ${slug}: no vendored copy to sync (docket init scaffolds it)`,
      );
      continue;
    }
    const source = await readFile(path, "utf8");
    const fm = source.match(/^---\n[\s\S]*?\n---\n/)?.[0];
    if (!fm) {
      console.log(`! ${rel}: no frontmatter — skipped, sync by hand`);
      continue;
    }
    const ours = source.slice(fm.length).trim();
    const result =
      ours === oldBase.trim()
        ? { content: theirs, conflict: false }
        : gitMerge3({
            ours: `${rel} (this repo)`,
            base: "last synced",
            theirs: "live template",
          })(oldBase.trim(), ours, theirs.trim());
    await writeFile(path, `${fm}\n${result.content.trim()}\n`, "utf8");
    if (result.conflict) {
      conflicts.push(rel);
      console.log(`✗ ${rel}: merge conflict — resolve the markers`);
    } else {
      console.log(
        `✓ ${rel}: ${ours === oldBase.trim() ? "fast-forwarded" : "merged (local customization kept)"}`,
      );
    }
  }
  return conflicts;
}

const ledger: LedgerEntry[] = existsSync(ledgerPath)
  ? JSON.parse(await readFile(ledgerPath, "utf8"))
  : [];
const head = ledger[0];

let conflicts: string[] = [];
if (!head) {
  ledger.unshift({ version: DOCKET_VERSION, bodies: live });
  console.log(`seeded ledger at ${DOCKET_VERSION}`);
} else if (head.version !== DOCKET_VERSION) {
  conflicts = await propagate(head.bodies);
  ledger.unshift({ version: DOCKET_VERSION, bodies: live });
  console.log(
    `froze ${head.version}; ledger now heads at ${DOCKET_VERSION} — run \`bun run docket upgrade\` in adopting repos`,
  );
} else {
  const changed = changedSlugs(head.bodies);
  if (changed.length === 0) {
    console.log(`ledger in sync with docket ${DOCKET_VERSION}`);
  } else {
    conflicts = await propagate(head.bodies);
    ledger[0] = { version: DOCKET_VERSION, bodies: live };
    console.log(`ledger head refreshed: ${changed.join(", ")}`);
  }
}
await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");

// Adapters (skill stubs, instruction sections, hook block) regenerate rather
// than merge — refresh them in the same breath so a template edit never waits
// on someone remembering `docket upgrade`.
if (existsSync(join(root, "docket.yaml"))) {
  const report = await runUpgrade(root, {});
  for (const item of report.items) {
    if (item.action !== "up-to-date")
      console.log(
        `${item.action}: ${item.path}${item.reason ? ` (${item.reason})` : ""}`,
      );
  }
}

if (conflicts.length > 0) {
  console.error(
    `\n${conflicts.length} conflict(s) left markers — resolve, then commit`,
  );
  process.exit(1);
}
