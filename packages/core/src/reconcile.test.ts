import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadBundle } from "./bundle";
import { parseConfig } from "./config";
import { LocalFileStore } from "./filestore";
import {
  applyReconciliation,
  planReconciliation,
  readReconciliationSource,
  recoverReconciliation,
} from "./reconcile";

const task = (
  id: number,
  status = "todo",
  body = "Original narrative.",
  extra = "",
) =>
  `---\ntype: Task\nid: RS-${id}\ntitle: Fixture ${id}\nstatus: ${status}\n${extra}---\n\n# Context\n\n${body}\n\n# Acceptance Criteria\n\n- [ ] Verify records.\n\n# Log\n\n`;
async function fixture(
  work: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>,
) {
  const f = await setup();
  try {
    await work(f);
  } finally {
    await rm(f.temp, { recursive: true, force: true });
  }
}
async function setup() {
  const temp = await mkdtemp(join(tmpdir(), "docket-reconcile-test-"));
  const root = join(temp, "main"),
    worker = join(temp, "worker");
  const git = async (cwd: string, ...args: string[]) => {
    const p = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Fixture",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code) throw new Error(err);
    return out.trim();
  };
  const put = async (cwd: string, path: string, source: string) => {
    await mkdir(join(cwd, "docket", path, ".."), { recursive: true });
    await writeFile(join(cwd, "docket", path), source);
  };
  const config = parseConfig("project: RS\nbundle: docket\n");
  await mkdir(join(root, "docket/work/tasks"), { recursive: true });
  await writeFile(join(root, "docket.yaml"), "project: RS\nbundle: docket\n");
  await put(root, "work/tasks/one.md", task(1));
  await put(root, "work/tasks/two.md", task(2));
  await put(root, "log.md", "# Log\n\nExisting entry.\n\n");
  await put(
    root,
    "index.md",
    "# Index\n\n<!-- docket:generated -->\n\nOld derived content.\n",
  );
  await git(root, "init", "-q");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "base");
  await git(root, "worktree", "add", "-qb", "closeout", worker);
  const store = new LocalFileStore(join(root, "docket"));
  const selection = (paths: string[], saved = false) => ({
    sourceRef: "closeout",
    paths,
    ...(saved ? { sourceRoot: worker, saved: true } : {}),
  });
  const commit = async () => {
    await git(worker, "add", ".");
    await git(worker, "commit", "-qm", "source records");
  };
  return { temp, root, worker, git, put, store, config, selection, commit };
}

test("different-task changes preserve unrelated dirty code, drafts and source branch; repeated application is a no-op", () =>
  fixture(async (f) => {
    await f.put(
      f.worker,
      "work/tasks/one.md",
      task(1, "todo", "Incoming compatible narrative."),
    );
    await f.commit();
    await f.put(
      f.root,
      "work/tasks/two.md",
      task(2, "todo", "Local compatible narrative."),
    );
    await f.put(
      f.root,
      "reference/draft.md",
      "---\ntype: Reference\ntitle: Draft\n---\n\nRetain me.\n",
    );
    await writeFile(join(f.root, "application.ts"), "dirty application code\n");
    const selection = f.selection([
      "work/tasks/one.md",
      "work/tasks/two.md",
      "index.md",
    ]);
    const before = await f.git(f.root, "status", "--porcelain");
    const head = await f.git(f.root, "rev-parse", "HEAD"),
      foreign = await f.git(f.worker, "status", "--porcelain");
    const plan = await planReconciliation(f.store, f.config, f.root, selection);
    expect(plan.items.map((row) => row.classification)).toEqual([
      "compatible",
      "unchanged",
      "unchanged",
    ]);
    expect(await f.git(f.root, "status", "--porcelain")).toBe(before);
    const request = {
      selection,
      expectedVersion: plan.version,
      choices: plan.items.map((row) => ({
        path: row.path,
        disposition: "merge-compatible",
      })),
    };
    const result = await applyReconciliation(
      f.store,
      f.config,
      f.root,
      request,
    );
    expect(result.state).toBe("applied");
    expect(result.changedPaths).toBe(2);
    expect(await f.store.read("work/tasks/two.md")).toContain(
      "Local compatible narrative.",
    );
    expect(await f.store.read("reference/draft.md")).toContain("Retain me.");
    expect(await readFile(join(f.root, "application.ts"), "utf8")).toBe(
      "dirty application code\n",
    );
    expect(await f.git(f.root, "rev-parse", "HEAD")).toBe(head);
    expect(await f.git(f.worker, "status", "--porcelain")).toBe(foreign);
    expect(
      (await applyReconciliation(f.store, f.config, f.root, request)).state,
    ).toBe("noop");
    await f.git(f.root, "add", ".");
    await f.git(f.root, "commit", "-qm", "accepted records committed");
    await f.put(
      f.root,
      "reference/later.md",
      "---\ntype: Reference\n---\n\nLater authored work.\n",
    );
    expect(
      (await applyReconciliation(f.store, f.config, f.root, request)).state,
    ).toBe("noop");
  }));

test("same-task independent prose and log additions merge once, generated index divergence is derived", () =>
  fixture(async (f) => {
    const base = task(
      1,
      "todo",
      "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.",
    );
    await f.put(f.root, "work/tasks/one.md", base);
    await f.git(f.root, "add", ".");
    await f.git(f.root, "commit", "-qm", "narrative base");
    await f
      .git(f.worker, "merge", "--ff-only", "main")
      .catch(() => f.git(f.worker, "merge", "--ff-only", "master"));
    await f.put(
      f.root,
      "work/tasks/one.md",
      `${base.replace("First paragraph.", "Local first.")}Local log entry.\n\n`,
    );
    await f.put(
      f.worker,
      "work/tasks/one.md",
      base.replace("Third paragraph.", "Incoming third.") +
        "Incoming log entry.\n\n",
    );
    await f.put(
      f.worker,
      "log.md",
      "# Log\n\nIncoming entry.\n\nExisting entry.\n\n",
    );
    await f.put(
      f.root,
      "log.md",
      "# Log\n\nLocal entry.\n\nExisting entry.\n\n",
    );
    await f.put(
      f.worker,
      "index.md",
      "# Index\n\n<!-- docket:generated -->\n\nForeign stale body.\n",
    );
    await f.commit();
    const selection = f.selection(["work/tasks/one.md", "log.md", "index.md"]);
    const plan = await planReconciliation(f.store, f.config, f.root, selection);
    expect(plan.items.map((row) => row.classification)).toEqual([
      "independent-log",
      "independent-log",
      "derived-index",
    ]);
    await applyReconciliation(f.store, f.config, f.root, {
      selection,
      expectedVersion: plan.version,
      choices: plan.items.map((row) => ({
        path: row.path,
        disposition: "merge-compatible",
      })),
    });
    const source = await f.store.read("work/tasks/one.md");
    for (const text of [
      "Local first.",
      "Incoming third.",
      "Local log entry.",
      "Incoming log entry.",
    ])
      expect(source.split(text).length).toBe(2);
    const log = await f.store.read("log.md");
    for (const text of ["Local entry.", "Incoming entry.", "Existing entry."])
      expect(log.split(text).length).toBe(2);
    expect(await f.store.read("index.md")).not.toContain("Foreign stale body.");
  }));

test("RS-372 accepted records preview 8/9 to 9/9, require review and preserve exact supplied narrative", () =>
  fixture(async (f) => {
    const epic =
      "---\ntype: Epic\nid: RS-372\ntitle: Import\nstatus: todo\n---\n";
    const path = "work/tasks/one.md",
      extra = "epic: /work/epics/import.md\n";
    await f.put(f.root, "work/epics/import.md", epic);
    await f.put(
      f.root,
      path,
      task(1, "todo", "Implementation already integrated.", extra),
    );
    for (let id = 2; id <= 9; id++)
      await f.put(
        f.root,
        `work/tasks/${id}.md`,
        task(id, "done", "Previously accepted.", extra),
      );
    await f.put(f.root, "work/tasks/two.md", task(20));
    await f.git(f.root, "add", ".");
    await f.git(f.root, "commit", "-qm", "implementation on recipient");
    await f.git(
      f.worker,
      "merge",
      "--ff-only",
      await f.git(f.root, "rev-parse", "HEAD"),
    );
    const narrative =
      "Accepted September 17: 938 imported recipes and 719 photos; verified backups, fidelity and duplicate-safe replay.";
    await f.put(
      f.worker,
      path,
      `${task(1, "done", "Implementation already integrated.", extra).replace(
        "- [ ]",
        "- [x]",
      )}# Outcome\n\n${narrative}\n`,
    );
    await f.commit();
    for (let n = 0; n < 2; n++) {
      await f.put(
        f.worker,
        `reference/closeout-${n}.md`,
        `---\ntype: Reference\ntitle: Follow-up ${n}\n---\n\nAccepted documentation record.\n`,
      );
      await f.commit();
    }
    const selection = f.selection([
      path,
      "reference/closeout-0.md",
      "reference/closeout-1.md",
    ]);
    const plan = await planReconciliation(f.store, f.config, f.root, selection);
    expect(plan.items[0]?.classification).toBe("semantic-review");
    expect(plan.epicCounts).toEqual([
      {
        path: "work/epics/import.md",
        localDone: 8,
        total: 9,
        proposedDone: 9,
        authority: "preview-only",
      },
    ]);
    const page = await readReconciliationSource(
      f.store,
      f.config,
      f.root,
      selection,
      plan.version,
      path,
      "incoming",
    );
    expect(page.text).toContain(narrative);
    const choices = [
      {
        path,
        disposition: "take-incoming",
        reason: "Reviewed accepted September 17 closeout.",
        acceptCompletion: true,
      },
      ...selection.paths.slice(1).map((path) => ({
        path,
        disposition: "take-incoming",
        reason: "Reviewed follow-up record.",
      })),
    ];
    await expect(
      applyReconciliation(f.store, f.config, f.root, {
        selection,
        expectedVersion: plan.version,
        choices: choices.map((c) => ({ ...c, acceptCompletion: false })),
      }),
    ).rejects.toThrow("acceptCompletion");
    expect((await loadBundle(f.store, f.config)).byId("RS-1")?.fm.status).toBe(
      "todo",
    );
    const accepted = await applyReconciliation(f.store, f.config, f.root, {
      selection,
      expectedVersion: plan.version,
      choices,
    });
    expect(accepted.state).toBe("applied");
    expect(accepted.integration).toBe("not-established");
    expect(await f.store.read(path)).toContain(narrative);
    expect((await loadBundle(f.store, f.config)).byId("RS-1")?.fm.status).toBe(
      "done",
    );
  }));

test("same-task conflicts need complete explicit resolution, forbidden terminal reopening and unfinished dependencies are rejected", () =>
  fixture(async (f) => {
    await f.put(
      f.worker,
      "work/tasks/one.md",
      task(1, "done", "Incoming completed narrative."),
    );
    await f.commit();
    await f.put(
      f.root,
      "work/tasks/one.md",
      task(1, "in-progress", "Local narrative."),
    );
    const selection = f.selection(["work/tasks/one.md"]),
      plan = await planReconciliation(f.store, f.config, f.root, selection);
    expect(plan.items[0]?.classification).toBe("conflict");
    await expect(
      applyReconciliation(f.store, f.config, f.root, {
        selection,
        expectedVersion: plan.version,
        choices: [
          { path: selection.paths[0], disposition: "merge-compatible" },
        ],
      }),
    ).rejects.toThrow("review reason");
    const input = {
      selection,
      expectedVersion: plan.version,
      choices: [
        {
          path: selection.paths[0],
          disposition: "resolve",
          reason: "Review keeps both narratives.",
          acceptCompletion: true,
          source: task(
            1,
            "done",
            "Local narrative. Incoming completed narrative.",
            "depends_on: [RS-2]\n",
          ),
        },
      ],
    };
    await expect(
      applyReconciliation(f.store, f.config, f.root, input),
    ).rejects.toThrow("unfinished");
    await f.put(f.root, "work/tasks/one.md", task(1, "done"));
    const done = await planReconciliation(f.store, f.config, f.root, selection);
    await expect(
      applyReconciliation(f.store, f.config, f.root, {
        ...input,
        expectedVersion: done.version,
        choices: [{ ...input.choices[0], source: task(1, "todo") }],
      }),
    ).rejects.toThrow("transition policy");
  }));

test("shadowed untracked drafts and duplicate identities are explicit collisions; resolved drafts retain originals", () =>
  fixture(async (f) => {
    const path = "work/tasks/new.md";
    await f.put(f.worker, path, task(3, "todo", "Incoming tracked source."));
    await f.commit();
    await f.put(f.root, path, task(3, "todo", "Untracked draft."));
    const selection = f.selection([path]),
      plan = await planReconciliation(f.store, f.config, f.root, selection);
    expect(plan.items[0]).toMatchObject({
      classification: "collision",
      untrackedDraft: true,
    });
    await expect(
      applyReconciliation(f.store, f.config, f.root, {
        selection,
        expectedVersion: plan.version,
        choices: [{ path, disposition: "take-incoming", reason: "Review" }],
      }),
    ).rejects.toThrow("untracked draft");
    const result = await applyReconciliation(f.store, f.config, f.root, {
      selection,
      expectedVersion: plan.version,
      choices: [
        {
          path,
          disposition: "resolve",
          reason: "Preserve draft plus tracked record.",
          source: task(3, "todo", "Untracked draft. Incoming tracked source."),
        },
      ],
    });
    expect(result.state).toBe("applied");
    if (!("journal" in result)) throw new Error("Expected retained journal");
    expect(await f.store.read(result.journal)).toContain("Untracked draft.");
    await f.put(f.worker, "work/tasks/duplicate.md", task(1));
    await f.commit();
    const duplicate = f.selection(["work/tasks/duplicate.md"]),
      colliding = await planReconciliation(
        f.store,
        f.config,
        f.root,
        duplicate,
      );
    expect(colliding.items[0]?.classification).toBe("collision");
    await expect(
      applyReconciliation(f.store, f.config, f.root, {
        selection: duplicate,
        expectedVersion: colliding.version,
        choices: [
          {
            path: duplicate.paths[0],
            disposition: "take-incoming",
            reason: "Reviewed",
          },
        ],
      }),
    ).rejects.toThrow("duplicate");
  }));

test("changed local/source inputs, incompatible configurations and symlinks fail before authored writes", () =>
  fixture(async (f) => {
    await f.put(
      f.worker,
      "work/tasks/one.md",
      task(1, "todo", "Saved source."),
    );
    const selection = f.selection(["work/tasks/one.md"], true),
      plan = await planReconciliation(f.store, f.config, f.root, selection);
    await f.put(
      f.worker,
      "work/tasks/one.md",
      task(1, "todo", "New saved source."),
    );
    await expect(
      applyReconciliation(f.store, f.config, f.root, {
        selection,
        expectedVersion: plan.version,
        choices: [
          { path: selection.paths[0], disposition: "merge-compatible" },
        ],
      }),
    ).rejects.toThrow("stale");
    expect(await f.store.read("work/tasks/one.md")).toContain(
      "Original narrative.",
    );
    const fresh = await planReconciliation(
      f.store,
      f.config,
      f.root,
      selection,
    );
    await f.put(
      f.root,
      "reference/new.md",
      "---\ntype: Reference\n---\n\nUnrelated draft.\n",
    );
    await expect(
      readReconciliationSource(
        f.store,
        f.config,
        f.root,
        selection,
        fresh.version,
        "work/tasks/one.md",
        "incoming",
      ),
    ).rejects.toThrow("changed");
    await writeFile(
      join(f.worker, "docket.yaml"),
      "project: OTHER\nbundle: docket\n",
    );
    await expect(
      planReconciliation(f.store, f.config, f.root, selection),
    ).rejects.toThrow("configuration differs");
    await symlink(
      join(f.worker, "docket/work/tasks/one.md"),
      join(f.root, "docket/work/tasks/link.md"),
    );
    await expect(
      planReconciliation(
        f.store,
        f.config,
        f.root,
        f.selection(["work/tasks/one.md"]),
      ),
    ).rejects.toThrow("filesystem links");
  }));

test("interrupted application retains original/planned bytes, recovery preserves applied records and refuses unrelated edits", () =>
  fixture(async (f) => {
    await f.put(
      f.worker,
      "work/tasks/one.md",
      task(1, "todo", "Incoming one."),
    );
    await f.put(
      f.worker,
      "work/tasks/two.md",
      task(2, "todo", "Incoming two."),
    );
    await f.commit();
    class Interrupted extends LocalFileStore {
      attempts = 0;
      override async write(path: string, source: string) {
        if (++this.attempts === 2) throw new Error("Controlled interruption");
        return super.write(path, source);
      }
    }
    const store = new Interrupted(f.store.root),
      selection = f.selection(["work/tasks/one.md", "work/tasks/two.md"]);
    const plan = await planReconciliation(store, f.config, f.root, selection);
    const result = await applyReconciliation(store, f.config, f.root, {
      selection,
      expectedVersion: plan.version,
      choices: selection.paths.map((path) => ({
        path,
        disposition: "merge-compatible",
      })),
    });
    expect(result.state).toBe("recovery_required");
    expect(result.writes).toBe(1);
    if (!("recoveryToken" in result))
      throw new Error("Expected recovery token");
    expect(await f.store.read("work/tasks/one.md")).toContain("Incoming one.");
    await f.put(
      f.root,
      "work/tasks/two.md",
      task(2, "todo", "Unrelated subsequent edit."),
    );
    const refused = await recoverReconciliation(
      f.store,
      f.config,
      f.root,
      result.recoveryToken,
    );
    expect(refused.state).toBe("recovery_required");
    expect(await f.store.read("work/tasks/two.md")).toContain(
      "Unrelated subsequent edit.",
    );
    await f.put(f.root, "work/tasks/two.md", task(2));
    expect(
      (
        await recoverReconciliation(
          f.store,
          f.config,
          f.root,
          result.recoveryToken,
        )
      ).state,
    ).toBe("applied");
    expect(
      (
        await recoverReconciliation(
          f.store,
          f.config,
          f.root,
          result.recoveryToken,
        )
      ).state,
    ).toBe("noop");
  }));

test("CLI plans and applies source-bound selections with bounded receipts and structured stale-plan failures", () =>
  fixture(async (f) => {
    await f.put(
      f.worker,
      "work/tasks/one.md",
      task(1, "todo", "CLI incoming."),
    );
    await f.commit();
    const selection = f.selection(["work/tasks/one.md"]),
      file = join(f.temp, "input.json");
    const cli = async (...args: string[]) => {
      const p = Bun.spawn(
        [
          process.execPath,
          resolve(import.meta.dir, "../../cli/src/index.ts"),
          "reconcile",
          ...args,
          "--json",
        ],
        { cwd: f.root, stdout: "pipe", stderr: "pipe" },
      );
      const [out, err, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      if (!out) throw new Error(err);
      return { code, bytes: Buffer.byteLength(out), value: JSON.parse(out) };
    };
    await writeFile(file, JSON.stringify(selection));
    const plan = await cli("plan", "--input", file);
    expect(plan.code).toBe(0);
    expect(plan.bytes).toBeLessThan(8192);
    const request = {
      selection,
      expectedVersion: plan.value.version,
      choices: [{ path: selection.paths[0], disposition: "merge-compatible" }],
    };
    await writeFile(file, JSON.stringify(request));
    const applied = await cli("apply", "--input", file);
    expect(applied.code).toBe(0);
    expect(applied.value.state).toBe("applied");
    expect(applied.bytes).toBeLessThan(1200);
    expect((await cli("apply", "--input", file)).value.state).toBe("noop");
    await writeFile(
      file,
      JSON.stringify({ ...request, expectedVersion: "a".repeat(64) }),
    );
    const failed = await cli("apply", "--input", file);
    expect(failed.code).toBe(1);
    expect(failed.value).toMatchObject({
      ok: false,
      mutation: "unchanged",
      error: { code: "source-conflict" },
    });
  }));

test("tampered recovery evidence is refused without replacing pending originals", () =>
  fixture(async (f) => {
    await f.put(
      f.worker,
      "work/tasks/one.md",
      task(1, "todo", "Reviewed source."),
    );
    await f.commit();
    class Interrupted extends LocalFileStore {
      override async write() {
        throw new Error("Controlled interruption");
      }
    }
    const selection = f.selection(["work/tasks/one.md"]),
      store = new Interrupted(f.store.root);
    const plan = await planReconciliation(store, f.config, f.root, selection);
    const result = await applyReconciliation(store, f.config, f.root, {
      selection,
      expectedVersion: plan.version,
      choices: [{ path: selection.paths[0], disposition: "merge-compatible" }],
    });
    if (!("journal" in result)) throw new Error("Expected recovery journal");
    const journal = JSON.parse(await f.store.read(result.journal));
    journal.rows[0].incoming = task(1, "done", "Unreviewed replacement.");
    await f.store.write(result.journal, JSON.stringify(journal));
    const recovery = await recoverReconciliation(
      f.store,
      f.config,
      f.root,
      result.recoveryToken,
    );
    expect(recovery.state).toBe("recovery_required");
    expect(recovery.error?.message).toContain("reviewed plan version");
    expect(await f.store.read("work/tasks/one.md")).toContain(
      "Original narrative.",
    );
  }));

test(
  "source pages and plan omissions remain bounded; missing sources are explicit and retained",
  () =>
    fixture(async (f) => {
      const paths = Array.from(
        { length: 12 },
        (_, n) => `reference/page-${n}.md`,
      );
      const body = "\u0001".repeat(2000) + "🧾".repeat(2000);
      for (const path of paths)
        await f.put(
          f.worker,
          path,
          `---\ntype: Reference\ntitle: Bounded source\n---\n\n${body}\n`,
        );
      await f.git(f.worker, "rm", "docket/work/tasks/one.md");
      await f.commit();
      const selection = f.selection([...paths, "work/tasks/one.md"]);
      const plan = await planReconciliation(
        f.store,
        f.config,
        f.root,
        selection,
      );
      expect(Buffer.byteLength(JSON.stringify(plan, null, 2))).toBeLessThan(
        8192,
      );
      expect(plan.omitted).toBe(selection.paths.length - plan.items.length);
      expect(plan.nextOffset).toBe(plan.items.length);
      const end = await planReconciliation(
        f.store,
        f.config,
        f.root,
        selection,
        12,
      );
      expect(end.items[0]?.classification).toBe("unavailable");
      let offset = 0,
        reconstructed = "";
      do {
        const page = await readReconciliationSource(
          f.store,
          f.config,
          f.root,
          selection,
          plan.version,
          paths[0] ?? "",
          "incoming",
          offset,
        );
        expect(Buffer.byteLength(JSON.stringify(page, null, 2))).toBeLessThan(
          8192,
        );
        reconstructed += page.text ?? "";
        if (page.nextOffset === null) break;
        expect(page.nextOffset).toBeGreaterThan(offset);
        offset = page.nextOffset;
      } while (offset < 10000);
      expect(reconstructed).toContain(body);
      const kept = await applyReconciliation(f.store, f.config, f.root, {
        selection,
        expectedVersion: plan.version,
        choices: selection.paths.map((path) => ({
          path,
          disposition: "keep-local",
        })),
      });
      expect(kept.state).toBe("noop");
      expect(await f.store.read("work/tasks/one.md")).toContain(
        "Original narrative.",
      );
    }),
  30_000,
);
