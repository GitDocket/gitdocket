import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type History = readonly { version: string; bodies: Record<string, string> }[];
type Report = {
  dryRun: boolean;
  conflicts: string[];
  reviewRequired: string[];
  items: { path: string; action: string }[];
};

const bodyOf = (source: string) =>
  source.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
const workflow = (slug: string, version: string, body: string) =>
  `---\ntype: Workflow\ntitle: ${slug}\norigin: ${slug}@${version}\ntags: [docket, workflow]\ntimestamp: 2026-01-01T00:00:00Z\n---\n\n${body}\n`;

/** Shared by source CI and exact-package/registry release smoke. No network or live repos. */
export async function verifyUpgradeCompatibility(options: {
  history: History;
  version: string;
  upgrade: (root: string, dryRun: boolean) => Promise<Report>;
}): Promise<void> {
  const current = options.history.find(
    (entry) => entry.version === options.version,
  );
  assert(current, "candidate must carry its current shipped bodies");
  const historical = options.history.filter(
    (entry) => entry.version !== options.version,
  );
  assert(
    historical.length > 0,
    "upgrade qualification requires historical merge bases",
  );
  const root = await mkdtemp(join(tmpdir(), "docket-upgrade-compatibility-"));
  const path = (slug: string) => join(root, "docket/workflows", `${slug}.md`);
  const relative = (slug: string) => `docket/workflows/${slug}.md`;
  try {
    await mkdir(join(root, "docket/workflows"), { recursive: true });
    await mkdir(join(root, "docket/reference"), { recursive: true });
    await writeFile(
      join(root, "docket.yaml"),
      "project: UPG\nbundle: docket/\n",
    );
    const guidancePath = join(root, "docket/reference/project-guidance.md");
    const guidance =
      "---\ntype: Reference\ntitle: Project guidance\ndescription: Authored standards\n---\n\nUse GraphQL for application APIs.\n";
    await writeFile(guidancePath, guidance);

    // Exercise every retained historical base, not just a freshly initialized current bundle.
    for (const previous of historical) {
      await rm(join(root, "docket/workflows"), { recursive: true });
      await mkdir(join(root, "docket/workflows"));
      const originals = new Map<string, string>();
      for (const [slug, body] of Object.entries(previous.bodies)) {
        if (!(slug in current.bodies)) continue;
        const source = workflow(slug, previous.version, body);
        originals.set(slug, source);
        await writeFile(path(slug), source);
      }
      const dry = await options.upgrade(root, true);
      assert.equal(dry.dryRun, true);
      assert.deepEqual(dry.conflicts, [], `clean ${previous.version} dry run`);
      for (const [slug, source] of originals)
        assert.equal(await readFile(path(slug), "utf8"), source);
      const upgraded = await options.upgrade(root, false);
      assert.deepEqual(
        upgraded.conflicts,
        [],
        `clean ${previous.version} upgrade`,
      );
      assert.deepEqual(upgraded.reviewRequired, []);
      for (const slug of originals.keys()) {
        const source = await readFile(path(slug), "utf8");
        assert.equal(
          bodyOf(source),
          current.bodies[slug]?.trim(),
          `${previous.version}: ${slug} must receive the current body`,
        );
        assert(source.includes(`origin: ${slug}@${options.version}`));
      }
      const repeated = await options.upgrade(root, false);
      assert(repeated.items.every((item) => item.action === "up-to-date"));
      assert.deepEqual(repeated.reviewRequired, []);
      assert.equal(await readFile(guidancePath, "utf8"), guidance);
    }

    const slug = "docket-close";
    const previous = historical.find((entry) => entry.bodies[slug]);
    assert(previous);
    const local =
      "Project requirement: update the team's changelog before closing.";
    await writeFile(
      path(slug),
      workflow(slug, previous.version, `${local}\n\n${previous.bodies[slug]}`),
    );
    const customized = await options.upgrade(root, false);
    assert.deepEqual(customized.conflicts, []);
    assert(customized.reviewRequired.includes(relative(slug)));
    const preserved = await readFile(path(slug), "utf8");
    assert.equal(bodyOf(preserved), `${local}\n\n${current.bodies[slug]}`);
    assert(
      preserved.includes("--without-completion"),
      "customization must not hide current close behavior",
    );
    assert(
      (await options.upgrade(root, false)).reviewRequired.includes(
        relative(slug),
      ),
    );
    assert.equal(await readFile(path(slug), "utf8"), preserved);

    // Actual generic workflow from the adopter incident: old completion-only body,
    // origin advanced to 0.2.1 without receiving that release's workflow changes.
    const stale = await readFile(
      new URL("./fixtures/upgrade/stale-close.md", import.meta.url),
      "utf8",
    );
    assert(!stale.includes("--without-completion"));
    await writeFile(path(slug), stale);
    const conflict = await options.upgrade(root, true);
    assert(
      conflict.conflicts.includes(relative(slug)),
      "the mis-stamped adopter body needs reconciliation",
    );
    assert.equal(await readFile(path(slug), "utf8"), stale);
    assert(
      (await options.upgrade(root, false)).conflicts.includes(relative(slug)),
    );
    assert((await readFile(path(slug), "utf8")).includes("<<<<<<<"));

    // An ours-only manual resolution must remain visible even after its origin advances.
    const incompleteResolution = stale.replace(
      "docket-close@0.2.1",
      `docket-close@${options.version}`,
    );
    await writeFile(path(slug), incompleteResolution);
    const unresolved = await options.upgrade(root, false);
    assert.deepEqual(unresolved.conflicts, []);
    assert(
      unresolved.reviewRequired.includes(relative(slug)),
      "current origin is not proof of current instructions",
    );
    assert.equal(await readFile(path(slug), "utf8"), incompleteResolution);

    await writeFile(
      path(slug),
      workflow(slug, options.version, current.bodies[slug] ?? ""),
    );
    assert.deepEqual((await options.upgrade(root, false)).reviewRequired, []);
    assert.equal(await readFile(guidancePath, "utf8"), guidance);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
