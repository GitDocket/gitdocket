import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportPublicSnapshot } from "./export-public";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

async function git(root: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn({
    cmd: ["git", "-C", root, ...args],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "GitDocket export test",
      GIT_AUTHOR_EMAIL: "export-test@example.invalid",
      GIT_COMMITTER_NAME: "GitDocket export test",
      GIT_COMMITTER_EMAIL: "export-test@example.invalid",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim());
  return stdout.trim();
}

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gitdocket-export-"));
  temporaryRoots.push(root);
  await git(root, "init", "-q");
  return root;
}

async function put(root: string, path: string, content: string): Promise<void> {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), content);
}

async function commit(root: string, message = "fixture"): Promise<string> {
  await git(root, "add", "-A");
  await git(root, "commit", "-qm", message);
  return git(root, "rev-parse", "HEAD");
}

async function writeManifest(root: string, paths: string[]): Promise<void> {
  await put(
    root,
    "release/public-export.json",
    `${JSON.stringify(
      { schema: 1, paths: [...paths, "release/public-export.json"].sort() },
      null,
      2,
    )}\n`,
  );
}

describe("public export", () => {
  test("copies one exact committed allowlist and records the source mapping", async () => {
    const source = await makeRepo();
    const destination = await makeRepo();
    await put(source, "README.md", "# Public\n");
    await put(
      source,
      "examples/basic/docket/decisions/DEC-1.md",
      "---\ntype: Decision\nid: DEC-1\n---\n",
    );
    await writeManifest(source, [
      "README.md",
      "examples/basic/docket/decisions/DEC-1.md",
    ]);
    const sourceCommit = await commit(source);

    const report = await exportPublicSnapshot({
      sourceRoot: source,
      sourceCommit,
      destination,
    });

    expect(report).toEqual({
      sourceCommit,
      additions: [
        "README.md",
        "examples/basic/docket/decisions/DEC-1.md",
        "release/public-export.json",
      ],
      changes: [],
      deletions: [],
    });
    expect(await readFile(join(destination, "README.md"), "utf8")).toBe(
      "# Public\n",
    );
    const state = JSON.parse(
      await readFile(join(destination, ".gitdocket-source.json"), "utf8"),
    );
    expect(state.sourceCommit).toBe(sourceCommit);
    expect(Object.keys(state.files).sort()).toEqual([
      "README.md",
      "examples/basic/docket/decisions/DEC-1.md",
      "release/public-export.json",
    ]);
  });

  test("reports and applies additions, changes, and deletions", async () => {
    const source = await makeRepo();
    const destination = await makeRepo();
    await put(source, "README.md", "one\n");
    await put(source, "old.txt", "old\n");
    await writeManifest(source, ["README.md", "old.txt"]);
    const firstCommit = await commit(source, "first");
    await exportPublicSnapshot({
      sourceRoot: source,
      sourceCommit: firstCommit,
      destination,
    });
    await commit(destination, "public first");

    await put(source, "README.md", "two\n");
    await rm(join(source, "old.txt"));
    await put(source, "new.txt", "new\n");
    await writeManifest(source, ["README.md", "new.txt"]);
    const secondCommit = await commit(source, "second");

    const dryRun = await exportPublicSnapshot({
      sourceRoot: source,
      sourceCommit: secondCommit,
      destination,
      dryRun: true,
    });
    expect(dryRun.additions).toEqual(["new.txt"]);
    expect(dryRun.changes).toEqual(["README.md", "release/public-export.json"]);
    expect(dryRun.deletions).toEqual(["old.txt"]);
    expect(await readFile(join(destination, "README.md"), "utf8")).toBe(
      "one\n",
    );

    await exportPublicSnapshot({
      sourceRoot: source,
      sourceCommit: secondCommit,
      destination,
    });
    expect(await readFile(join(destination, "README.md"), "utf8")).toBe(
      "two\n",
    );
    expect(await readFile(join(destination, "new.txt"), "utf8")).toBe("new\n");
    await expect(
      readFile(join(destination, "old.txt"), "utf8"),
    ).rejects.toThrow();
  });

  test("refuses a clean destination whose files lack prior export state", async () => {
    const source = await makeRepo();
    const destination = await makeRepo();
    await put(source, "README.md", "public\n");
    await writeManifest(source, ["README.md"]);
    const sourceCommit = await commit(source);
    await put(destination, "unrelated.txt", "not managed\n");
    await commit(destination);

    await expect(
      exportPublicSnapshot({ sourceRoot: source, sourceCommit, destination }),
    ).rejects.toThrow("destination is unexplained");
  });

  test("rejects secret-bearing and private-project content before writing", async () => {
    const source = await makeRepo();
    const destination = await makeRepo();
    const privateName = ["Recipe", "Snag"].join("");
    await put(source, "README.md", `Notes copied from ${privateName}\n`);
    await writeManifest(source, ["README.md"]);
    const sourceCommit = await commit(source);

    await expect(
      exportPublicSnapshot({ sourceRoot: source, sourceCommit, destination }),
    ).rejects.toThrow("private cross-project evidence");
    expect(await git(destination, "status", "--porcelain")).toBe("");
  });

  test("requires the exact clean source HEAD", async () => {
    const source = await makeRepo();
    const destination = await makeRepo();
    await put(source, "README.md", "public\n");
    await writeManifest(source, ["README.md"]);
    const sourceCommit = await commit(source);
    await put(source, "README.md", "uncommitted\n");

    await expect(
      exportPublicSnapshot({ sourceRoot: source, sourceCommit, destination }),
    ).rejects.toThrow("source Git checkout must be clean");
  });
});
