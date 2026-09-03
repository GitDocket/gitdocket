// trailerlessSince against a real fixture repo: trailerless work
// commits count, trailered commits and sanctioned chore(docket) chores don't
// — so a freshness sweep's own commit no longer re-fires the nag it cleared.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trailerlessSince } from "./freshness";

let root: string;
let baseline: string;

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

const commit = async (message: string) => {
  await writeFile(join(root, "f.txt"), message);
  git("add", "f.txt");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "--short", "HEAD");
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "docket-freshness-"));
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  baseline = await commit("baseline");
  await commit("feat: work with trailer\n\nTask: FIX-1");
  await commit("fix: trailerless work commit");
  await commit("chore(docket): freshness review — no drift");
  await commit("chore(docket): groom backlog");
});

afterAll(() => rm(root, { recursive: true, force: true }));

describe("trailerlessSince", () => {
  test("counts only trailerless work commits — chores and trailered commits exempt", () => {
    expect(trailerlessSince(root, baseline, "Task")).toBe(1);
  });

  test("empty range → 0; unknown sha → undefined", () => {
    expect(
      trailerlessSince(root, git("rev-parse", "--short", "HEAD"), "Task"),
    ).toBe(0);
    expect(trailerlessSince(root, "0000000", "Task")).toBeUndefined();
  });

  test("not a git checkout → undefined", () => {
    expect(trailerlessSince(tmpdir(), "abc1234", "Task")).toBeUndefined();
  });
});
