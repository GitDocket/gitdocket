import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  validateChannelReceipts,
  validateDockerReceipt,
  validateMacosReceipts,
  verifyQualificationMatrix,
} from "./macos-qualification";
import { checkLevelForTarget } from "./standalone-smoke";

function fixture(arch: "arm64" | "x64" = "arm64") {
  const version = "0.4.0";
  const source = {
    kind: "public-export" as const,
    commit: "a".repeat(40),
    exportSha256: "b".repeat(64),
  };
  const smoke = {
    level: "deep" as "basic" | "deep",
    version,
    platform: "darwin" as const,
    arch,
    runtimePath: "Git and standalone executables only",
    checks: [
      "CLI/MCP versions",
      "dual-agent initialization",
      "task create/ready/index",
      "embedded browser assets",
      "MCP ready tool",
      "source-only watch diagnostic",
      "historical/customized/stale upgrades",
    ],
  };
  const native: Parameters<typeof validateMacosReceipts>[0] = {
    schema: 1,
    status: "READY",
    version,
    source,
    target: arch === "arm64" ? "darwin-arm64" : "darwin-x64",
    bunVersion: "1.3.14",
    archive: `gitdocket-${version}-darwin-${arch}.tar.gz`,
    sha256: "c".repeat(64),
    files: {},
    smoke,
  };
  const shared = {
    status: "READY" as const,
    version,
    source: structuredClone(source),
    archiveSha256: native.sha256,
    qualificationHost: {
      platform: "darwin" as const,
      arch: arch as "arm64" | "x64",
      osRelease: "26.0.0",
      distribution: "Ubuntu 24.04.3 LTS",
      osVersion: "27.0",
      hardwareArch: "arm64" as const,
      execution: arch === "x64" ? "rosetta" : "native",
    },
  };
  const npm = {
    ...structuredClone(shared),
    level: "deep" as "basic" | "deep",
    platform: "darwin" as const,
    arch,
    node: "v22.23.2",
    npm: "11.17.0",
    productPath: "Node, Git and npm launchers; no Bun",
    checks: [
      "npm global install",
      "npx acquisition",
      "CLI/MCP versions",
      "initialization/task/index",
      "embedded Serve resources",
      "MCP ready call",
      "historical/customized/stale upgrades",
      "npm update",
      "npm uninstall preserves project",
      "migration from published Bun-dependent 0.3.1",
    ],
    smoke: {
      level: "deep" as "basic" | "deep",
      packageVersions: {
        "@gitdocket/cli": version,
        "@gitdocket/mcp": version,
        [`@gitdocket/bin-darwin-${arch}`]: version,
      },
      mcpTools: ["ready"],
      serveStatus: 200,
    },
  };
  const brew = {
    ...structuredClone(shared),
    level: "deep" as "basic" | "deep",
    target: native.target,
    formulaSha256: "d".repeat(64),
    smoke: structuredClone(smoke),
    checks: [
      "formula install and both executable hashes",
      "formula functional test",
      "reinstall",
      "revision upgrade",
      "failed checksum preserves accepted keg",
      "failed download preserves accepted keg",
      "published npm 0.3.1 precedence",
      "preserved custom MCP path and explicit migration",
      "MCP actual tool through stable Homebrew opt path",
      "uninstall preserves project and competing npm installation",
    ],
  };
  return { native, npm, brew };
}

test("local ARM and Rosetta channel receipts must match the qualified archive", () => {
  for (const arch of ["arm64", "x64"] as const) {
    const { native, npm, brew } = fixture(arch);
    expect(() => validateMacosReceipts(native, npm, brew)).not.toThrow();
    npm.source.commit = "e".repeat(40);
    expect(() => validateMacosReceipts(native, npm, brew)).toThrow(
      "source differs",
    );
    npm.source.commit = native.source.commit;
    brew.archiveSha256 = "e".repeat(64);
    expect(() => validateMacosReceipts(native, npm, brew)).toThrow(
      "archive differs",
    );
  }
});

test("rejects wrong architecture, undisclosed Rosetta, and missing installed checks", () => {
  const { native, npm, brew } = fixture("x64");
  npm.qualificationHost.arch = "arm64";
  expect(() => validateMacosReceipts(native, npm, brew)).toThrow(
    "execution architecture differs",
  );
  npm.qualificationHost.arch = "x64";
  npm.qualificationHost.execution = "native";
  expect(() => validateMacosReceipts(native, npm, brew)).toThrow(
    "translation assistance",
  );
  npm.qualificationHost.execution = "rosetta";
  npm.checks = npm.checks.filter(
    (check) => check !== "historical/customized/stale upgrades",
  );
  expect(() => validateMacosReceipts(native, npm, brew)).toThrow(
    "missing macOS npm check",
  );
  npm.checks.push("historical/customized/stale upgrades");
  brew.checks.pop();
  expect(() => validateMacosReceipts(native, npm, brew)).toThrow(
    "missing macOS Homebrew check",
  );
});

test("lean x64 receipts retain installed checks and reject a false deep claim", () => {
  const { native, npm, brew } = fixture("x64");
  native.smoke.level = "basic";
  native.smoke.checks = native.smoke.checks.slice(0, 5);
  npm.level = "basic";
  npm.smoke.level = "basic";
  npm.checks = npm.checks.slice(0, 6);
  brew.level = "basic";
  brew.smoke.level = "basic";
  brew.smoke.checks = brew.smoke.checks.slice(0, 5);
  brew.checks = brew.checks.slice(0, 2);
  expect(() => validateMacosReceipts(native, npm, brew)).not.toThrow();
  expect(() => validateMacosReceipts(native, npm, brew, "deep")).toThrow(
    "check level differs",
  );
  npm.level = "deep";
  expect(() => validateMacosReceipts(native, npm, brew)).toThrow(
    "check level differs",
  );
  npm.level = "basic";
  brew.smoke.checks.pop();
  expect(() => validateMacosReceipts(native, npm, brew)).toThrow(
    "missing basic Homebrew smoke",
  );
});

test("lean and full matrix receipts cannot be mixed", async () => {
  expect(checkLevelForTarget("darwin-arm64")).toBe("deep");
  expect(checkLevelForTarget("linux-x64")).toBe("basic");
  expect(checkLevelForTarget("linux-x64", true)).toBe("deep");
  const root = await mkdtemp(join(tmpdir(), "qualification-matrix-"));
  const names = [
    "npm-darwin-arm64",
    "homebrew-darwin-arm64",
    "npm-linux-arm64",
    "homebrew-linux-arm64",
    "npm-darwin-x64",
    "homebrew-darwin-x64",
    "npm-linux-x64",
    "homebrew-linux-x64",
    "npm-linux-x64-node24",
  ];
  try {
    for (const name of names)
      await writeFile(
        join(root, `${name}.json`),
        JSON.stringify({ level: name.includes("arm64") ? "deep" : "basic" }),
      );
    expect(await verifyQualificationMatrix(root)).toBe("lean");
    await writeFile(
      join(root, "npm-linux-x64-node24.json"),
      '{"level":"deep"}',
    );
    await expect(verifyQualificationMatrix(root)).rejects.toThrow(
      "differs from matrix",
    );
    for (const name of names.filter((name) => name.includes("x64")))
      await writeFile(join(root, `${name}.json`), '{"level":"deep"}');
    expect(await verifyQualificationMatrix(root, true)).toBe("full");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("draft import has push access without checking out code, while qualification stays read-only", async () => {
  type Workflow = {
    permissions: Record<string, string>;
    jobs: Record<
      string,
      {
        permissions?: Record<string, string>;
        steps?: { uses?: string }[];
      }
    >;
  };
  const readWorkflow = async (name: string) =>
    Bun.YAML.parse(
      await Bun.file(
        join(import.meta.dir, "..", ".github", "workflows", name),
      ).text(),
    ) as Workflow;
  const standalone = await readWorkflow("standalone.yml");
  expect(standalone.permissions).toEqual({ contents: "read" });
  for (const [name, job] of Object.entries(standalone.jobs)) {
    expect(job.permissions ?? standalone.permissions).toEqual({
      contents: name === "qualified-assets" ? "write" : "read",
    });
  }
  expect(
    standalone.jobs["qualified-assets"]?.steps?.some((step) =>
      step.uses?.startsWith("actions/checkout@"),
    ),
  ).toBe(false);
  const publish = await readWorkflow("publish.yml");
  expect(publish.jobs.standalone?.permissions).toEqual({ contents: "write" });
  expect(publish.jobs.preflight?.permissions).toEqual({ contents: "read" });
  expect(publish.jobs.registry?.permissions).toEqual({
    contents: "read",
    "id-token": "write",
  });
});

test("all hosted workflows, including the generated tap, resolve to Linux runners", async () => {
  const root = resolve(import.meta.dir, "..");
  const paths = [
    ...new Bun.Glob(".github/workflows/*.{yml,yaml}").scanSync({
      cwd: root,
      dot: true,
    }),
    "release/homebrew-template/.github/workflows/verify.yml.in",
  ];
  expect(paths.length).toBeGreaterThanOrEqual(5);
  for (const path of paths) {
    const workflow = Bun.YAML.parse(
      await Bun.file(join(root, path)).text(),
    ) as {
      jobs: Record<
        string,
        {
          uses?: string;
          "runs-on"?: string;
          strategy?: {
            matrix: Record<string, unknown> & {
              include?: Record<string, string>[];
            };
          };
        }
      >;
    };
    for (const [name, job] of Object.entries(workflow.jobs)) {
      if (job.uses) {
        expect(job.uses).toBe("./.github/workflows/standalone.yml");
        continue;
      }
      const runner = job["runs-on"];
      expect(typeof runner).toBe("string");
      const variable = runner?.match(/^\$\{\{ matrix\.(\w+) \}\}$/)?.[1];
      const matrix = job.strategy?.matrix;
      const runners = variable
        ? [
            ...(Array.isArray(matrix?.[variable])
              ? (matrix[variable] as string[])
              : []),
            ...(matrix?.include?.map((row) => row[variable] ?? "") ?? []),
          ]
        : [runner ?? ""];
      expect(runners.length).toBeGreaterThan(0);
      for (const label of runners)
        expect(label, `${path}: ${name}`).toMatch(/^ubuntu-/);
    }
  }
});

test("Linux receipts disclose Docker emulation and preserve installed-channel requirements", () => {
  const { native, npm, brew } = fixture("x64");
  native.target = "linux-x64";
  native.smoke.platform = "linux" as typeof native.smoke.platform;
  brew.target = native.target;
  brew.smoke = structuredClone(native.smoke) as typeof brew.smoke;
  npm.platform = "linux" as typeof npm.platform;
  npm.smoke.packageVersions["@gitdocket/bin-linux-x64"] = native.version;
  for (const receipt of [npm, brew]) {
    receipt.qualificationHost.platform =
      "linux" as typeof receipt.qualificationHost.platform;
    receipt.qualificationHost.execution = "docker-emulated";
  }
  expect(() => validateChannelReceipts(native, npm, brew)).not.toThrow();
  npm.qualificationHost.execution = "native";
  expect(() => validateChannelReceipts(native, npm, brew)).toThrow(
    "translation assistance",
  );
  npm.qualificationHost.execution = "docker-emulated";
  npm.node = "v24.2.0";
  expect(() => validateChannelReceipts(native, npm, brew, 24)).not.toThrow();
  brew.archiveSha256 = "e".repeat(64);
  expect(() => validateChannelReceipts(native, npm, brew, 24)).toThrow(
    "archive differs",
  );
});

test("Docker summaries reject incomplete runs, wrong source and hidden emulation", () => {
  const native = fixture().native;
  const receipt = {
    schema: 1,
    mode: "build",
    status: "READY",
    sourceCommit: native.source.commit,
    exportSha256: native.source.exportSha256 as string,
    engine: { architecture: "arm64", version: "29.3.1", os: "Docker Desktop" },
    completed: ["arm64", "x64"].map((arch) => ({
      target: `linux-${arch}`,
      platform: `linux/${arch === "x64" ? "amd64" : arch}`,
      execution: arch === "arm64" ? "docker-native" : "docker-emulated",
      imageId: `sha256:${"a".repeat(64)}`,
      artifacts: { [`linux-${arch}.json`]: "b".repeat(64) },
    })),
  };
  expect(() =>
    validateDockerReceipt(receipt, "build", native.source),
  ).not.toThrow();
  receipt.status = "FAILED";
  expect(() => validateDockerReceipt(receipt, "build", native.source)).toThrow(
    "not complete",
  );
  receipt.status = "READY";
  receipt.sourceCommit = "b".repeat(40);
  expect(() =>
    validateDockerReceipt(receipt, "build", native.source),
  ).toThrow();
  receipt.sourceCommit = native.source.commit;
  const x64 = receipt.completed[1];
  if (!x64) throw new Error("missing x64 fixture");
  x64.execution = "docker-native";
  expect(() =>
    validateDockerReceipt(receipt, "build", native.source),
  ).toThrow();
});
