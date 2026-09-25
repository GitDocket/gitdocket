import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type History = readonly { version: string; bodies: Record<string, string> }[];
type Report = {
  dryRun: boolean;
  conflicts: string[];
  reviewRequired: string[];
  items: { path: string; action: string }[];
  extensionDiscovery?: { ok: boolean; diagnostics: { code: string }[] };
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
  const writingRule = "Do not hard-wrap Markdown prose.";
  for (const body of Object.values(current.bodies))
    assert(
      body.includes(writingRule),
      "candidate workflows must carry the engine writing rule",
    );
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

    const extension = await extensionPreservationFixture(root);
    const upgrade = async (dryRun: boolean) => {
      const report = await options.upgrade(root, dryRun);
      await extension.assertPreserved();
      assert(
        report.extensionDiscovery,
        "upgrade must report current extension compatibility/discovery",
      );
      assert.equal(
        report.extensionDiscovery.ok,
        true,
        "the compatible fixture stays mechanically valid",
      );
      return report;
    };

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
      const pointersBefore = await readFile(join(root, "AGENTS.md"), "utf8");
      const dry = await upgrade(true);
      assert.equal(dry.dryRun, true);
      assert.deepEqual(dry.conflicts, [], `clean ${previous.version} dry run`);
      for (const [slug, source] of originals)
        assert.equal(await readFile(path(slug), "utf8"), source);
      assert.equal(
        await readFile(join(root, "AGENTS.md"), "utf8"),
        pointersBefore,
      );
      const upgraded = await upgrade(false);
      assert(
        (await readFile(join(root, "AGENTS.md"), "utf8")).includes(
          "`upgrade-check:review`",
        ),
      );
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
        assert(
          source.includes(writingRule),
          `${previous.version}: ${slug} must receive the writing rule`,
        );
      }
      if (current.bodies["docket-wiki"]) {
        assert.equal(
          bodyOf(await readFile(path("docket-wiki"), "utf8")),
          current.bodies["docket-wiki"].trim(),
        );
      }
      const repeated = await upgrade(false);
      assert(repeated.items.every((item) => item.action === "up-to-date"));
      assert.deepEqual(repeated.reviewRequired, []);
      assert.equal(await readFile(guidancePath, "utf8"), guidance);
    }

    // An unacknowledged source remains review-required through a core upgrade;
    // no version stamp or adapter refresh can acknowledge it on the user's behalf.
    await extension.requireLocalReview();
    const unreviewed = await upgrade(false);
    assert(
      unreviewed.extensionDiscovery?.diagnostics.some(
        (entry) => entry.code === "local-review-required",
      ),
    );
    assert.equal(
      await readFile(join(root, "AGENTS.md"), "utf8"),
      extension.handwritten,
    );

    const pickupSlug = "docket-pickup";
    const pickupCurrentBody = current.bodies[pickupSlug];
    const pickupPrevious = historical.find(
      (entry) =>
        entry.bodies[pickupSlug] &&
        entry.bodies[pickupSlug] !== pickupCurrentBody,
    );
    assert(pickupPrevious);
    const pickupPreviousBody = pickupPrevious.bodies[pickupSlug];
    assert(pickupPreviousBody);
    assert(pickupCurrentBody);
    const pickupLocal = "Project requirement: name the reviewer before pickup.";
    await writeFile(
      path(pickupSlug),
      workflow(
        pickupSlug,
        pickupPrevious.version,
        `${pickupLocal}\n\n${pickupPreviousBody}`,
      ),
    );
    const pickupUpgrade = await upgrade(false);
    assert.deepEqual(pickupUpgrade.conflicts, []);
    assert(pickupUpgrade.reviewRequired.includes(relative(pickupSlug)));
    const pickupBody = bodyOf(await readFile(path(pickupSlug), "utf8"));
    assert(pickupBody.includes(pickupLocal));
    assert(pickupBody.includes("active-task-conflict"));
    assert(pickupBody.includes("May I create a linked Git worktree at <path>"));

    const stalePickup = workflow(
      pickupSlug,
      options.version,
      pickupPreviousBody,
    );
    await writeFile(path(pickupSlug), stalePickup);
    const stalePickupUpgrade = await upgrade(false);
    assert.deepEqual(stalePickupUpgrade.conflicts, []);
    assert(stalePickupUpgrade.reviewRequired.includes(relative(pickupSlug)));
    assert.equal(await readFile(path(pickupSlug), "utf8"), stalePickup);
    await writeFile(
      path(pickupSlug),
      workflow(pickupSlug, options.version, pickupCurrentBody),
    );

    const wikiSlug = "docket-wiki";
    const wikiCurrent = current.bodies[wikiSlug];
    assert(wikiCurrent);
    assert(wikiCurrent.includes("docket document move-plan"));
    const wikiLocal =
      "Project requirement: explain page reorganization in the review summary.";
    const customizedWiki = workflow(
      wikiSlug,
      options.version,
      `${wikiLocal}\n\n${wikiCurrent}`,
    );
    await writeFile(path(wikiSlug), customizedWiki);
    assert((await upgrade(false)).reviewRequired.includes(relative(wikiSlug)));
    assert.equal(await readFile(path(wikiSlug), "utf8"), customizedWiki);
    const staleWiki = workflow(
      wikiSlug,
      options.version,
      wikiCurrent
        .split("\n")
        .filter((line) => !line.includes("docket document move-plan"))
        .join("\n"),
    );
    assert(!staleWiki.includes("docket document move-plan"));
    await writeFile(path(wikiSlug), staleWiki);
    assert((await upgrade(false)).reviewRequired.includes(relative(wikiSlug)));
    assert.equal(await readFile(path(wikiSlug), "utf8"), staleWiki);
    await writeFile(
      path(wikiSlug),
      workflow(wikiSlug, options.version, wikiCurrent),
    );
    assert(!(await upgrade(false)).reviewRequired.includes(relative(wikiSlug)));

    const taskSlug = "docket-task";
    const taskPrevious = historical.find(
      (entry) =>
        entry.bodies[taskSlug] &&
        entry.bodies[taskSlug] !== current.bodies[taskSlug],
    );
    assert(taskPrevious);
    const taskCurrent = current.bodies[taskSlug];
    assert(taskCurrent);
    assert(taskCurrent.includes("docket decision create"));
    const taskLocal =
      "Project requirement: include the review date in each decision record.";
    await writeFile(
      path(taskSlug),
      workflow(
        taskSlug,
        taskPrevious.version,
        `${taskLocal}\n\n${taskPrevious.bodies[taskSlug]}`,
      ),
    );
    const taskUpgrade = await upgrade(false);
    assert(
      taskUpgrade.conflicts.includes(relative(taskSlug)) ||
        taskUpgrade.reviewRequired.includes(relative(taskSlug)),
    );
    const taskCustomized = await readFile(path(taskSlug), "utf8");
    assert(
      taskCustomized.includes(taskLocal),
      "local Decision instructions must survive upgrade",
    );
    assert(
      taskCustomized.includes("docket decision create"),
      "current Decision mechanics must arrive, including on reviewable merge sides",
    );
    const staleTask = workflow(
      taskSlug,
      options.version,
      taskPrevious.bodies[taskSlug] ?? "",
    );
    await writeFile(path(taskSlug), staleTask);
    assert((await upgrade(false)).reviewRequired.includes(relative(taskSlug)));
    assert.equal(await readFile(path(taskSlug), "utf8"), staleTask);
    await writeFile(
      path(taskSlug),
      workflow(taskSlug, options.version, taskCurrent),
    );
    assert(!(await upgrade(false)).reviewRequired.includes(relative(taskSlug)));

    const slug = "docket-close";
    const previous = historical.find((entry) => entry.bodies[slug]);
    assert(previous);
    const local =
      "Project requirement: update the team's changelog before closing.";
    await writeFile(
      path(slug),
      workflow(slug, previous.version, `${local}\n\n${previous.bodies[slug]}`),
    );
    const customized = await upgrade(false);
    assert.deepEqual(customized.conflicts, []);
    assert(customized.reviewRequired.includes(relative(slug)));
    const preserved = await readFile(path(slug), "utf8");
    assert.equal(bodyOf(preserved), `${local}\n\n${current.bodies[slug]}`);
    assert(preserved.includes(writingRule));
    assert(
      preserved.includes("--without-completion"),
      "customization must not hide current close behavior",
    );
    assert((await upgrade(false)).reviewRequired.includes(relative(slug)));
    assert.equal(await readFile(path(slug), "utf8"), preserved);

    // Actual generic workflow from the adopter incident: old completion-only body,
    // origin advanced to 0.2.1 without receiving that release's workflow changes.
    const stale = await readFile(
      new URL("./fixtures/upgrade/stale-close.md", import.meta.url),
      "utf8",
    );
    assert(!stale.includes("--without-completion"));
    assert(!stale.includes(writingRule));
    await writeFile(path(slug), stale);
    const conflict = await upgrade(true);
    assert(
      conflict.conflicts.includes(relative(slug)),
      "the mis-stamped adopter body needs reconciliation",
    );
    assert.equal(await readFile(path(slug), "utf8"), stale);
    assert((await upgrade(false)).conflicts.includes(relative(slug)));
    assert((await readFile(path(slug), "utf8")).includes("<<<<<<<"));

    // An ours-only manual resolution must remain visible even after its origin advances.
    const incompleteResolution = stale.replace(
      "docket-close@0.2.1",
      `docket-close@${options.version}`,
    );
    await writeFile(path(slug), incompleteResolution);
    const unresolved = await upgrade(false);
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
    assert.deepEqual((await upgrade(false)).reviewRequired, []);
    assert.equal(await readFile(guidancePath, "utf8"), guidance);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Self-contained repository bytes: shared installed-candidate smoke must test
 * the candidate's upgrade path without importing the source checkout's engine. */
async function extensionPreservationFixture(root: string) {
  const hash = (text: string) =>
    createHash("sha256").update(text, "utf8").digest("hex");
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([left], [right]) =>
                left < right ? -1 : left > right ? 1 : 0,
              )
              .map(([key, entry]) => [key, canonical(entry)]),
          )
        : value;
  const manifest = {
    formatVersion: 1,
    id: "upgrade-check",
    version: "1.0.0",
    title: "Upgrade preservation",
    description: "Shared installed-candidate extension preservation fixture",
    engine: { min: "0.0.0", maxExclusive: "99.0.0" },
    files: ["workflows/review.md"],
    workflows: [
      {
        id: "review",
        title: "Review",
        description: "Review a project-owned completed proposal",
        path: "workflows/review.md",
      },
    ],
    guidance: [],
    defaults: { reviewer: "package default" },
    capabilities: [],
    scenarios: [],
  };
  const base =
    "---\ntype: Workflow\ntitle: Review\ndescription: Review project delivery\n---\nRead project guidance before review.\n";
  const local = `${base}\nProject requirement: retain the custom release checklist.\n`;
  const retired =
    "---\ntype: Reference\ntitle: Retired template\ndescription: Historical source retained for completed links\n---\nEarlier proposal template.\n";
  const digest = hash(
    JSON.stringify([canonical(manifest), [["workflows/review.md", base]]]),
  );
  const record = {
    manifest,
    digest,
    base: { "workflows/review.md": base },
    status: "installed",
    requestedEnabled: true,
    config: { reviewer: "project reviewer" },
    bindings: {},
    reviewedLocal: { "workflows/review.md": hash(local) } as Record<
      string,
      string
    >,
    retainedFiles: {
      "templates/retired.md": {
        base: retired,
        baseHash: hash(retired),
        sourceVersion: "0.9.0",
        sourceDigest: "a".repeat(64),
      },
    },
    source: "/nonexistent/original-author-cache",
  };
  const files = new Map([
    [
      "docket/extensions/registry.json",
      `${JSON.stringify({ formatVersion: 1, packages: { "upgrade-check": record } }, null, 2)}\n`,
    ],
    ["docket/extensions/upgrade-check/workflows/review.md", local],
    ["docket/extensions/upgrade-check/templates/retired.md", retired],
    [
      "docket/reference/completed-delivery.md",
      "---\ntype: Reference\ntitle: Completed delivery\ndescription: Historical project evidence\n---\n[Template](/extensions/upgrade-check/templates/retired.md)\n",
    ],
  ]);
  for (const [path, text] of files) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
  const handwritten =
    "Project instruction: preserve our extension adaptations.\n";
  await writeFile(join(root, "AGENTS.md"), handwritten);
  return {
    handwritten,
    async assertPreserved() {
      for (const [path, text] of files)
        assert.equal(
          await readFile(join(root, path), "utf8"),
          text,
          `engine upgrade must preserve exact package/project bytes: ${path}`,
        );
    },
    async requireLocalReview() {
      record.reviewedLocal = {};
      const path = "docket/extensions/registry.json";
      const text = `${JSON.stringify({ formatVersion: 1, packages: { "upgrade-check": record } }, null, 2)}\n`;
      files.set(path, text);
      await writeFile(join(root, path), text);
    },
  };
}
