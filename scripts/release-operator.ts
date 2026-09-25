import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  classifyRegistry,
  PACKAGE_IDS,
  type PublicationCandidate,
  RELEASE_NPM_VERSION,
  RELEASE_REGISTRY,
  RELEASE_REPOSITORY,
  type RegistryBoundary,
  type RegistryReceipt,
  type RegistryView,
  stableJson,
} from "./release-publication";
import { NpmRegistryBoundary } from "./release-publish";

export { saveReceipt, waitUntil } from "./release-wait";

import {
  exitFor,
  type Observation,
  saveReceipt,
  waitUntil,
} from "./release-wait";
export type Reader = Pick<RegistryBoundary, "inspect">;

export function validateCandidate(value: unknown): PublicationCandidate {
  const candidate = value as PublicationCandidate;
  if (
    !candidate ||
    candidate.repository !== RELEASE_REPOSITORY ||
    candidate.registry !== RELEASE_REGISTRY ||
    candidate.npmVersion !== RELEASE_NPM_VERSION ||
    candidate.holdingTag !== "staged" ||
    candidate.publicTag !== "latest" ||
    !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(candidate.version) ||
    candidate.sourceTag !== `v${candidate.version}` ||
    !/^[a-f0-9]{40}$/.test(candidate.publicCommit) ||
    !/^[a-f0-9]{64}$/.test(candidate.stageReceiptSha256) ||
    !Array.isArray(candidate.packages) ||
    candidate.packages.length !== PACKAGE_IDS.length
  ) {
    throw new Error("invalid coordinated GitDocket publication candidate");
  }
  for (const [index, id] of PACKAGE_IDS.entries()) {
    const item = candidate.packages[index];
    if (
      !item ||
      item.id !== id ||
      item.name !== `@gitdocket/${id}` ||
      item.version !== candidate.version ||
      !/^sha512-[A-Za-z0-9+/]+=*$/.test(item.integrity) ||
      !item.dependencies ||
      item.repository?.url !==
        "git+https://github.com/GitDocket/gitdocket.git" ||
      item.repository.directory !== `packages/${id}`
    ) {
      throw new Error(`invalid coordinated package ${id}`);
    }
  }
  return candidate;
}

export async function registryObservation(
  candidate: PublicationCandidate,
  registry: Reader,
  tag: string,
): Promise<Observation> {
  if (tag !== candidate.holdingTag && tag !== candidate.publicTag)
    throw new Error("wait tag must be staged or latest");
  const views = await Promise.all(
    candidate.packages.map((item) => registry.inspect(item.name, item.version)),
  );
  const state = classifyRegistry(candidate, views);
  const conflicts = state.packages.filter((item) =>
    item.reasons.some(
      (reason) =>
        reason !== "trusted-publisher provenance is absent" &&
        reason !== "SLSA provenance predicate is absent",
    ),
  );
  return {
    state: conflicts.length
      ? "CONFLICT"
      : state.classification === "complete" &&
          (tag === candidate.holdingTag ? state.holding : state.public) ===
            "complete"
        ? "READY"
        : "PENDING",
    detail: state,
  };
}

export interface OwnerBoundary {
  whoami(): Promise<string>;
  login(): Promise<void>;
}
export async function ownerLogin(
  owner: OwnerBoundary,
  user: string,
  check: boolean,
): Promise<void> {
  if (!user.trim()) throw new Error("expected npm owner is required");
  if (!check) await owner.login();
  if ((await owner.whoami()) !== user)
    throw new Error("npm owner mismatch; no dist-tag writes permitted");
}

export async function promoteOwner(options: {
  receipt: RegistryReceipt;
  user: string;
  check: boolean;
  owner: OwnerBoundary;
  registry: Reader & Pick<RegistryBoundary, "setTag">;
  persist: (value: unknown) => Promise<void>;
  previous?: {
    candidate: PublicationCandidate;
    actions: string[];
    check: boolean;
  };
}): Promise<Observation> {
  const { receipt, registry } = options;
  const candidate = validateCandidate(receipt.candidate);
  if (
    receipt.schema !== 1 ||
    receipt.smoke?.packageVersions?.["@gitdocket/cli"] !== candidate.version ||
    receipt.smoke?.packageVersions?.["@gitdocket/mcp"] !== candidate.version ||
    !candidate.packages.some(
      (item) =>
        item.id.startsWith("bin-") &&
        receipt.smoke?.packageVersions?.[item.name] === candidate.version,
    ) ||
    Object.values(receipt.smoke?.packageVersions ?? {}).some(
      (version) => version !== candidate.version,
    ) ||
    receipt.smoke.serveStatus !== 200 ||
    !receipt.smoke.mcpTools?.length ||
    receipt.final?.classification !== "complete" ||
    receipt.final.holding !== "complete" ||
    receipt.initial?.packages?.length !== candidate.packages.length
  ) {
    throw new Error(
      "promotion requires the exact staged registry receipt with successful installed smoke",
    );
  }
  await ownerLogin(options.owner, options.user, true);
  if (
    options.previous &&
    stableJson(options.previous.candidate) !== stableJson(candidate)
  )
    throw new Error(
      "promotion output belongs to another candidate; preserve it and choose a new path",
    );
  const actions: string[] =
    options.previous && !options.previous.check
      ? [...options.previous.actions]
      : [];

  const persist = (state: string, detail: unknown) =>
    options.persist({
      schema: 1,
      candidate,
      state,
      detail,
      actions: [...actions],
      check: options.check,
      user: options.user,
      observedAt: new Date().toISOString(),
    });
  const allowed = (name: string, view: RegistryView) => {
    const baseline = receipt.initial.packages.find(
      (item) => item.name === name,
    );
    if (!baseline) throw new Error(`missing prior tag observation for ${name}`);
    const tag = view.distTags.latest;
    if (tag !== candidate.version && tag !== baseline.distTags.latest) {
      throw new Error(
        `latest changed since the reviewed preflight for ${name}; reconcile before promotion`,
      );
    }
    if (view.distTags.staged !== candidate.version)
      throw new Error(`staged changed for ${name}`);
  };
  try {
    const ready = await registryObservation(
      candidate,
      registry,
      candidate.holdingTag,
    );
    if (ready.state !== "READY") {
      await persist(ready.state, ready.detail);
      return ready;
    }
    // Check the complete set before the first write, then recheck each package immediately before mutation.
    for (const item of candidate.packages)
      allowed(item.name, await registry.inspect(item.name, item.version));
    await persist("VERIFIED", ready.detail);
    for (const item of candidate.packages) {
      const view = await registry.inspect(item.name, item.version);
      const state = classifyRegistry({ ...candidate, packages: [item] }, [
        view,
      ]);
      if (state.classification !== "complete")
        throw new Error(`immutable registry state changed for ${item.name}`);
      allowed(item.name, view);
      if (view.distTags.latest === candidate.version)
        actions.push(`kept ${item.name} latest at ${candidate.version}`);
      else if (
        actions.includes(`promoted ${item.name}@${candidate.version} latest`)
      ) {
        // Preserve an accepted write while registry reads are still stale.
      } else if (options.check)
        actions.push(`would promote ${item.name}@${candidate.version} latest`);
      else {
        await registry.setTag(item.name, candidate.version, "latest");
        actions.push(`promoted ${item.name}@${candidate.version} latest`);
      }
      await persist("VERIFIED", { package: item.name });
    }
    const result = options.check
      ? ready
      : await registryObservation(candidate, registry, "latest");
    await persist(result.state, result.detail);
    return result;
  } catch (error) {
    await persist(
      "CONFLICT",
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}

export function readOptions(
  args: string[],
  permitted: string[],
  flags: string[] = [],
): Record<string, string> {
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i]?.replace(/^--/, "");
    if (
      !key ||
      !args[i]?.startsWith("--") ||
      !permitted.includes(key) ||
      key in values
    )
      throw new Error(`unknown or duplicate option ${args[i]}`);
    if (flags.includes(key)) values[key] = "true";
    else {
      const value = args[++i];
      if (!value || value.startsWith("--"))
        throw new Error(`--${key} requires a value`);
      values[key] = value;
    }
  }
  return values;
}
export function required(values: Record<string, string>, key: string): string {
  if (!values[key]) throw new Error(`--${key} is required`);
  return values[key];
}
export async function jsonFile<T = unknown>(path: string): Promise<T> {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

export function capture(args: string[], cwd = process.cwd()): string {
  const result = Bun.spawnSync(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });
  if (result.exitCode !== 0)
    throw new Error(
      `${args[0]} ${args[1]} failed: ${result.stderr.toString().trim()}`,
    );
  return result.stdout.toString().trim();
}
const ownerBoundary: OwnerBoundary = {
  whoami: async () =>
    capture(["npm", "whoami", "--registry", RELEASE_REGISTRY]),
  login: async () => {
    if (!process.stdin.isTTY)
      throw new Error("login requires the owner's interactive Terminal");
    const child = Bun.spawn(["npm", "login", "--registry", RELEASE_REGISTRY], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await child.exited) !== 0) throw new Error("npm login failed");
  },
};
function requireNpm(): void {
  if (capture(["npm", "--version"]) !== RELEASE_NPM_VERSION)
    throw new Error(`requires npm ${RELEASE_NPM_VERSION}`);
  if (capture(["npm", "config", "get", "registry"]) !== RELEASE_REGISTRY)
    throw new Error(`requires registry ${RELEASE_REGISTRY}`);
}

export function githubObservation(
  run: { status: string; conclusion: string | null; headSha: string },
  commit: string,
): Observation {
  if (run.headSha !== commit)
    return {
      state: "CONFLICT",
      detail: "GitHub run source differs from expected commit",
    };
  return {
    state:
      run.status !== "completed"
        ? "PENDING"
        : run.conclusion === "success"
          ? "READY"
          : "CONFLICT",
    detail: run,
  };
}

export async function operatorCommand(
  command: string,
  args: string[],
): Promise<number> {
  const resume = ["bun", "run", "release", "--", command, ...args];
  if (command === "login") {
    const values = readOptions(args, ["user", "check"], ["check"]);
    requireNpm();
    await ownerLogin(
      ownerBoundary,
      required(values, "user"),
      values.check === "true",
    );
    console.log("[release-login] READY expected owner verified; no tag writes");
    return 0;
  }
  if (command === "promote") {
    const values = readOptions(
      args,
      ["input", "user", "check", "output"],
      ["check"],
    );
    const output = required(values, "output");
    const input = required(values, "input");
    if (resolve(output) === resolve(input))
      throw new Error("promotion output must preserve the input receipt");
    requireNpm();
    const registry = new NpmRegistryBoundary();
    const result = await promoteOwner({
      receipt: await jsonFile<RegistryReceipt>(input),
      previous: (await Bun.file(output).exists())
        ? await jsonFile(output)
        : undefined,
      user: required(values, "user"),
      check: values.check === "true",
      owner: ownerBoundary,
      registry: {
        inspect: registry.inspect.bind(registry),
        setTag: async (name, version, tag) => {
          if (!process.stdin.isTTY)
            throw new Error(
              "promotion requires the owner's interactive Terminal for 2FA",
            );
          const child = Bun.spawn(
            [
              "npm",
              "dist-tag",
              "add",
              `${name}@${version}`,
              tag,
              "--registry",
              RELEASE_REGISTRY,
            ],
            { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
          );
          if ((await child.exited) !== 0)
            throw new Error(
              `npm promotion failed for ${name}; inspect before retrying`,
            );
        },
      },
      persist: (value) => saveReceipt(output, value),
    });
    console.log(`[release-promote] ${result.state} ${output}`);
    return exitFor[result.state];
  }
  const predicate = args.shift();
  const values = readOptions(args, [
    "input",
    "tag",
    "repo",
    "run",
    "commit",
    "manifest",
    "output",
    "timeout-ms",
    "interval-ms",
  ]);
  const output = required(values, "output");
  let observe: () => Promise<Observation>;
  if (predicate === "registry") {
    const input = required(values, "input");
    if (resolve(input) === resolve(output))
      throw new Error("wait output must preserve input");
    const candidate = validateCandidate(
      (await jsonFile<{ candidate: unknown }>(input)).candidate,
    );
    const tag = required(values, "tag");
    if (!["staged", "latest"].includes(tag))
      throw new Error("registry tag must be staged or latest");
    observe = () =>
      registryObservation(candidate, new NpmRegistryBoundary(), tag);
  } else if (predicate === "github" || predicate === "tap") {
    const repo = required(values, "repo");
    const commit = required(values, "commit");
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[a-f0-9]{40}$/.test(commit))
      throw new Error("expected repository and full commit are required");
    if (predicate === "github") required(values, "run");
    observe = async () => {
      let run = values.run;
      if (!run) {
        const runs = JSON.parse(
          capture([
            "gh",
            "run",
            "list",
            "--repo",
            repo,
            "--workflow",
            "verify.yml",
            "--commit",
            commit,
            "--json",
            "databaseId",
            "--limit",
            "1",
          ]),
        );
        run = runs[0]?.databaseId?.toString();
        if (!run)
          return { state: "PENDING", detail: "tap verify run not yet listed" };
      }
      const view = JSON.parse(
        capture([
          "gh",
          "run",
          "view",
          run,
          "--repo",
          repo,
          "--json",
          "status,conclusion,headSha,databaseId,url",
        ]),
      );
      return githubObservation(view, commit);
    };
  } else if (predicate === "site") {
    const manifestPath = required(values, "manifest");
    if (resolve(manifestPath) === resolve(output))
      throw new Error("wait output must preserve the site manifest");
    const manifest = (await jsonFile(manifestPath)) as {
      files: Array<{ url: string; sha256: string }>;
    };
    if (
      !Array.isArray(manifest.files) ||
      !manifest.files.length ||
      manifest.files.some(
        (file) =>
          !/^https:\/\//.test(file.url) || !/^[a-f0-9]{64}$/.test(file.sha256),
      )
    )
      throw new Error("site manifest requires HTTPS URLs and SHA-256 values");
    observe = async () => {
      const files = [];
      for (const file of manifest.files) {
        const response = await fetch(file.url, {
          signal: AbortSignal.timeout(30_000),
          headers: { "User-Agent": "curl/8.0" },
        });
        const hash = new Bun.CryptoHasher("sha256")
          .update(new Uint8Array(await response.arrayBuffer()))
          .digest("hex");
        files.push({
          ...file,
          status: response.status,
          observedSha256: hash,
          matches: response.ok && hash === file.sha256,
        });
      }
      return {
        state: files.every((file) => file.matches) ? "READY" : "PENDING",
        detail: files,
      };
    };
  } else
    throw new Error("wait requires registry, github, tap or site predicate");
  const result = await waitUntil({
    predicate: { name: predicate, ...values },
    observe,
    output,
    resume,
    timeoutMs:
      values["timeout-ms"] === undefined
        ? undefined
        : Number(values["timeout-ms"]),
    intervalMs:
      values["interval-ms"] === undefined
        ? undefined
        : Number(values["interval-ms"]),
    progress: console.error,
  });
  return exitFor[result.state];
}
