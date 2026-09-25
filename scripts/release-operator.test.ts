import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  githubObservation,
  ownerLogin,
  promoteOwner,
  registryObservation,
  validateCandidate,
  waitUntil,
} from "./release-operator";
import {
  classifyRegistry,
  PACKAGE_IDS,
  type PublicationCandidate,
  type RegistryReceipt,
  type RegistryView,
} from "./release-publication";

function fixture() {
  const candidate: PublicationCandidate = {
    version: "0.5.1",
    sourceTag: "v0.5.1",
    publicCommit: "a".repeat(40),
    stageReceiptSha256: "b".repeat(64),
    repository: "GitDocket/gitdocket",
    registry: "https://registry.npmjs.org/",
    npmVersion: "11.17.0",
    workflowRef: "unused",
    holdingTag: "staged",
    publicTag: "latest",
    packages: PACKAGE_IDS.map((id) => ({
      id,
      name: `@gitdocket/${id}`,
      version: "0.5.1",
      tarball: `${id}.tgz`,
      integrity: "sha512-YQ==",
      dependencies: {},
      repository: {
        url: "git+https://github.com/GitDocket/gitdocket.git",
        directory: `packages/${id}`,
      },
    })),
  };
  const views: RegistryView[] = candidate.packages.map((item) => ({
    version: {
      ...item,
      provenanceUrl: "https://registry.npmjs.org/evidence",
      provenancePredicate: "https://slsa.dev/provenance/v1",
    },
    distTags: { staged: candidate.version, latest: "0.5.0", retained: "0.1.0" },
  }));
  const receipt: RegistryReceipt = {
    schema: 1,
    candidate,
    initial: structuredClone(classifyRegistry(candidate, views)),
    final: classifyRegistry(candidate, views),
    actions: [],
    smoke: {
      packageVersions: {
        "@gitdocket/cli": candidate.version,
        "@gitdocket/mcp": candidate.version,
        "@gitdocket/bin-linux-x64": candidate.version,
      },
      serveStatus: 200,
      mcpTools: ["ready"],
    },
    completedAt: "fixture",
  };
  const writes: string[] = [];
  const registry = {
    inspect: async (name: string) =>
      structuredClone(
        views[
          candidate.packages.findIndex((item) => item.name === name)
        ] as RegistryView,
      ),
    setTag: async (name: string, version: string, tag: string) => {
      writes.push(name);
      const view = views[
        candidate.packages.findIndex((item) => item.name === name)
      ] as RegistryView;
      view.distTags[tag] = version;
    },
  };
  return { candidate, views, receipt, registry, writes };
}
const owner = {
  whoami: async () => "owner",
  login: async () => {
    throw new Error("must not login during promotion");
  },
};

describe("operator propagation", () => {
  test("timeout persists last observation and resume arguments without writes; rerun reaches ready", async () => {
    const directory = await mkdtemp(join(tmpdir(), "release-wait-"));
    try {
      let now = 0;
      const output = join(directory, "wait.json");
      const options = {
        predicate: "registry",
        output,
        resume: ["bun", "run", "release", "--", "wait", "registry"],
        timeoutMs: 20,
        intervalMs: 10,
        now: () => now,
        sleep: async (ms: number) => {
          now += ms;
        },
      };
      expect(
        (
          await waitUntil({
            ...options,
            observe: async () => ({
              state: "PENDING",
              detail: "accepted but invisible",
            }),
          })
        ).state,
      ).toBe("PENDING");
      const receipt = JSON.parse(await readFile(output, "utf8"));
      expect(receipt.detail).toBe("accepted but invisible");
      expect(receipt.exitCode).toBe(2);
      expect(receipt.externalWrites).toBe(false);
      expect(receipt.resume).toEqual(options.resume);
      expect(
        (
          await waitUntil({
            ...options,
            observe: async () => ({ state: "READY", detail: "visible" }),
          })
        ).state,
      ).toBe("READY");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("immutable mismatch conflicts; delayed provenance is pending", async () => {
    const f = fixture();
    const version = f.views[0]?.version;
    if (!version) throw new Error("missing fixture");
    version.provenanceUrl = undefined;
    expect(
      (await registryObservation(f.candidate, f.registry, "staged")).state,
    ).toBe("PENDING");
    version.integrity = "sha512-other";
    expect(
      (await registryObservation(f.candidate, f.registry, "staged")).state,
    ).toBe("CONFLICT");
    expect(f.writes).toEqual([]);
  });
  test("run source identity and failed completion cannot report ready", () => {
    expect(
      githubObservation(
        { status: "completed", conclusion: "success", headSha: "wrong" },
        "expected",
      ).state,
    ).toBe("CONFLICT");
    expect(
      githubObservation(
        { status: "completed", conclusion: "failure", headSha: "expected" },
        "expected",
      ).state,
    ).toBe("CONFLICT");
    expect(
      githubObservation(
        { status: "queued", conclusion: null, headSha: "expected" },
        "expected",
      ).state,
    ).toBe("PENDING");
  });
});

describe("owner promotion", () => {
  test("separate login checks owner; stale login fails before any tag write", async () => {
    const calls: string[] = [];
    await ownerLogin(
      {
        login: async () => {
          calls.push("login");
        },
        whoami: async () => {
          calls.push("whoami");
          return "owner";
        },
      },
      "owner",
      false,
    );
    expect(calls).toEqual(["login", "whoami"]);
    const f = fixture();
    await expect(
      promoteOwner({
        ...f,
        user: "different",
        check: false,
        owner,
        persist: async () => {},
      }),
    ).rejects.toThrow("owner mismatch");
    expect(f.writes).toEqual([]);
  });
  test("check never mutates; partial promotion resumes preserving correct and unrelated tags", async () => {
    const f = fixture();
    await promoteOwner({
      ...f,
      user: "owner",
      check: true,
      owner,
      persist: async () => {},
    });
    expect(f.writes).toEqual([]);
    const first = f.views[0];
    if (!first) throw new Error("missing fixture");
    first.distTags.latest = f.candidate.version;
    expect(
      (
        await promoteOwner({
          ...f,
          user: "owner",
          check: false,
          owner,
          persist: async () => {},
        })
      ).state,
    ).toBe("READY");
    expect(f.writes.length).toBe(PACKAGE_IDS.length - 1);
    expect(f.views.every((view) => view.distTags.retained === "0.1.0")).toBe(
      true,
    );
  });
  test("changed unrelated latest and immutable conflict refuse before writes", async () => {
    for (const conflict of ["latest", "integrity"]) {
      const f = fixture();
      const last = f.views.at(-1) as RegistryView;
      if (conflict === "latest") last.distTags.latest = "9.0.0";
      else if (last.version) last.version.integrity = "sha512-conflict";
      try {
        await promoteOwner({
          ...f,
          user: "owner",
          check: false,
          owner,
          persist: async () => {},
        });
      } catch {}
      expect(f.writes).toEqual([]);
    }
  });
  test("accepted writes survive a pending observation and are not repeated on resume", async () => {
    const f = fixture();
    let previous: Parameters<typeof promoteOwner>[0]["previous"];
    const options = {
      ...f,
      user: "owner",
      check: false,
      owner,
      registry: {
        ...f.registry,
        setTag: async (name: string) => {
          f.writes.push(name);
        },
      },
      persist: async (value: unknown) => {
        previous = value as typeof previous;
      },
    };
    expect((await promoteOwner(options)).state).toBe("PENDING");
    expect(f.writes.length).toBe(8);
    expect((await promoteOwner({ ...options, previous })).state).toBe(
      "PENDING",
    );
    expect(f.writes.length).toBe(8);
  });
  test("malformed package sets fail closed", () => {
    const f = fixture();
    f.candidate.packages.pop();
    expect(() => validateCandidate(f.candidate)).toThrow("invalid coordinated");
  });
});
