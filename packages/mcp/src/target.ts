import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_FILENAME,
  type DocketConfig,
  type FileStore,
  findRepoRoot,
  GitWorktreeIdCoordinator,
  LocalFileStore,
  parseConfig,
} from "@gitdocket/core";
import { Telemetry } from "@gitdocket/core/telemetry";
import {
  type RepositoryInput,
  RepositoryOwner,
  type RepositoryResolver,
} from "./owner";

export interface TargetOptions {
  pin?: string;
}
export const TARGETING_RULE =
  "Checkout targeting: use request _meta docket/target {root, identity?} for an explicit target; it must agree with --repo pins. Otherwise client roots select one checkout; clients without roots use launch fallback. Mutation receipts include checkout identity. Shell cwd does not retarget MCP.";
export interface RootProvider {
  supported: boolean;
  notifications: boolean;
  list(): Promise<{ roots: { uri: string }[] }>;
}
export interface CheckoutReceipt {
  supported: boolean;
  root?: string;
  identity?: string;
  selectedBy: "request" | "pin" | "client-roots" | "launch" | "embedded";
  rootsSupported: boolean;
  matched: boolean;
  intentConfirmed: boolean;
}
export class TargetError extends Error {
  constructor(
    readonly code:
      | "invalid-target"
      | "target-unavailable"
      | "ambiguous-target"
      | "target-mismatch"
      | "target-changed"
      | "target-capacity"
      | "target-containment",
    message: string,
    readonly mutation: "unchanged" | "partial" | "unknown" = "unchanged",
  ) {
    super(message);
  }
}
interface LoadedTarget extends RepositoryInput {
  root: string;
  identity: string;
}
interface Entry {
  owner: RepositoryOwner;
  input: LoadedTarget;
  active: number;
  telemetry: Telemetry;
  coordinator: GitWorktreeIdCoordinator;
}
export interface BoundTarget {
  owner: RepositoryOwner;
  receipt: CheckoutReceipt;
  mutation: boolean;
  writes: number;
  targetFailure?: TargetError;
  entry?: Entry;
}
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
};
function targetPath(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > 2048)
    throw new TargetError(
      "invalid-target",
      "Target must be an absolute checkout path or local file URI within the 2048-byte identity budget.",
    );
  let path = value;
  if (value.startsWith("file:")) {
    try {
      path = fileURLToPath(value);
    } catch {
      throw new TargetError(
        "invalid-target",
        "Target file URI must identify a local absolute checkout path.",
      );
    }
  }
  if (!isAbsolute(path) || path.includes("\0"))
    throw new TargetError(
      "invalid-target",
      "Target must identify an absolute checkout path.",
    );
  return path;
}
function requestTarget(
  value: unknown,
): { path: string; identity?: string } | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return { path: targetPath(value) };
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TargetError(
      "invalid-target",
      "docket/target must be a path or an object containing root and optional identity.",
    );
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).some((key) => key !== "root" && key !== "identity") ||
    (data.identity !== undefined &&
      (typeof data.identity !== "string" ||
        !/^[a-f0-9]{64}$/.test(data.identity)))
  )
    throw new TargetError(
      "invalid-target",
      "Target identity must be the complete checkout identity returned by Docket.",
    );
  return {
    path: targetPath(data.root),
    ...(data.identity ? { identity: data.identity as string } : {}),
  };
}

/** Discovery is bounded and never falls back after explicit caller evidence fails. */
async function loadTarget(
  path: string,
  discover = false,
): Promise<LoadedTarget> {
  try {
    const actual = await realpath(path);
    const discovered = discover ? await findRepoRoot(actual) : actual;
    if (!discovered) throw new Error("missing configuration");
    const root = await realpath(discovered);
    if (Buffer.byteLength(root) > 2048)
      throw new TargetError(
        "invalid-target",
        "Resolved checkout identity exceeds the response budget.",
      );
    const info = await lstat(root, { bigint: true });
    if (!info.isDirectory()) throw new Error("checkout is not a directory");
    const manifest = resolve(root, CONFIG_FILENAME);
    const manifestInfo = await lstat(manifest);
    if (!manifestInfo.isFile() || manifestInfo.size > 262144)
      throw new Error("invalid configuration file");
    const source = await readFile(manifest, "utf8");
    const config = parseConfig(source);
    const bundle = resolve(root, config.bundle);
    const actualBundle = await realpath(bundle);
    const bundleInfo = await lstat(actualBundle);
    if (
      !bundleInfo.isDirectory() ||
      !inside(root, bundle) ||
      !inside(root, actualBundle)
    )
      throw new Error("bundle outside checkout");
    const identity = digest(
      `${root}\0${info.dev}:${info.ino}\0${digest(source)}\0${actualBundle}\0${bundleInfo.dev}:${bundleInfo.ino}`,
    );
    return { root, identity, config, store: new LocalFileStore(actualBundle) };
  } catch (error) {
    if (error instanceof TargetError) throw error;
    throw new TargetError(
      "target-unavailable",
      "Target checkout, configuration or contained bundle is missing, unreadable or invalid. Restore or explicitly select the intended checkout before retrying.",
    );
  }
}

class GuardedStore extends LocalFileStore {
  constructor(
    root: string,
    private readonly verify: () => Promise<void>,
    private readonly wrote: () => void,
    private readonly failed: (error: TargetError) => TargetError,
  ) {
    super(root);
  }
  override async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    await this.verify();
    return super.withMutation(async () => {
      await this.verify();
      return operation();
    });
  }
  private async contained(path: string) {
    if (
      isAbsolute(path) ||
      path.includes("\\") ||
      path.includes("\0") ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw this.failed(
        new TargetError(
          "target-containment",
          "Mutation source must remain inside its bound bundle.",
        ),
      );
    let current = this.root;
    for (const part of path.split("/")) {
      current = resolve(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink())
          throw this.failed(
            new TargetError(
              "target-containment",
              "Mutation source cannot follow a filesystem link away from its bound path.",
            ),
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
    }
  }
  override async write(path: string, content: string) {
    await this.verify();
    await this.contained(path);
    await super.write(path, content);
    this.wrote();
  }
  override async createExclusive(path: string, content: string) {
    await this.verify();
    await this.contained(path);
    const created = await super.createExclusive(path, content);
    if (created) this.wrote();
    return created;
  }
  override async remove(path: string) {
    await this.verify();
    await this.contained(path);
    await super.remove(path);
    this.wrote();
  }
}

/** Each request leases an immutable owner/input; there is no mutable global target. */
export class TargetRouter {
  private readonly scope = new AsyncLocalStorage<BoundTarget>();
  private readonly entries = new Map<string, Entry>();
  private roots?: Promise<{ roots: { uri: string }[] }>;
  private rootsEpoch = 0;
  private closed = false;
  readonly launchOwner: RepositoryOwner;
  readonly local: boolean;
  constructor(
    store: FileStore,
    config: DocketConfig,
    private readonly launch?: string,
    resolver?: RepositoryResolver,
    private readonly options: TargetOptions = {},
  ) {
    this.local = store instanceof LocalFileStore && launch !== undefined;
    this.launchOwner = new RepositoryOwner(
      resolver ?? (async () => ({ store, config })),
      launch,
    );
  }
  current() {
    return this.scope.getStore();
  }
  invalidateRoots() {
    this.rootsEpoch++;
    this.roots = undefined;
  }
  private async clientRoots(provider: RootProvider): Promise<LoadedTarget[]> {
    const epoch = this.rootsEpoch;
    if (provider.notifications && !this.roots) this.roots = provider.list();
    const pending =
      (provider.notifications ? this.roots : undefined) ?? provider.list();
    let roots: { uri: string }[];
    try {
      roots = (await pending).roots;
    } catch {
      if (this.roots === pending) this.roots = undefined;
      throw new TargetError(
        "target-unavailable",
        "Client roots support is advertised but workspace roots could not be read. Supply an explicit intended target or restore client support.",
      );
    }
    if (epoch !== this.rootsEpoch)
      throw new TargetError(
        "target-changed",
        "Workspace roots changed during target selection. Retry target selection; no mutation began.",
      );
    if (roots.length === 0 || roots.length > 16)
      throw new TargetError(
        roots.length ? "ambiguous-target" : "target-unavailable",
        "Client roots must identify one intended checkout or be disambiguated by an explicit target/pin; empty or oversized root inventories cannot select a write target.",
      );
    const targets = await Promise.all(
      roots.map(({ uri }) => loadTarget(targetPath(uri), true)),
    );
    if (epoch !== this.rootsEpoch)
      throw new TargetError(
        "target-changed",
        "Workspace roots changed during checkout discovery. Retry target selection; no mutation began.",
      );
    return [
      ...new Map(targets.map((target) => [target.root, target])).values(),
    ];
  }
  async bind(
    meta: Record<string, unknown> | undefined,
    provider: RootProvider,
    mutation: boolean,
  ): Promise<BoundTarget> {
    if (this.closed)
      throw new TargetError(
        "target-unavailable",
        "MCP target router is closed.",
      );
    const request = requestTarget(meta?.["docket/target"]);
    if (!this.local) {
      if (request || this.options.pin || provider.supported)
        throw new TargetError(
          "target-unavailable",
          "Checkout routing is unavailable for an embedded nonlocal store. Use the embedding's explicit repository binding.",
        );
      return {
        owner: this.launchOwner,
        mutation,
        writes: 0,
        receipt: {
          supported: false,
          selectedBy: "embedded",
          rootsSupported: false,
          matched: true,
          intentConfirmed: true,
        },
      };
    }
    const requested = request ? await loadTarget(request.path) : undefined;
    const pin = this.options.pin
      ? await loadTarget(targetPath(this.options.pin))
      : undefined;
    if (pin && requested && pin.root !== requested.root)
      throw new TargetError(
        "target-mismatch",
        "Explicit target conflicts with the deliberate server pin. Use a server pinned to the intended checkout; do not retry this write against the other checkout.",
      );
    // An explicit target is higher precedence than workspace inventory, and can
    // disambiguate multi-root clients without an extra roots roundtrip.
    const roots =
      !requested && provider.supported
        ? await this.clientRoots(provider)
        : undefined;
    if (pin && roots && !roots.some((target) => target.root === pin.root))
      throw new TargetError(
        "target-mismatch",
        "Client workspace intent conflicts with the deliberate server pin. Select the intended pinned server or send a matching explicit target.",
      );
    if (!requested && !pin && roots && roots.length !== 1)
      throw new TargetError(
        "ambiguous-target",
        "Client workspace roots identify multiple Docket checkouts. Supply an explicit docket/target; no mutation began.",
      );
    const input =
      requested ??
      pin ??
      roots?.[0] ??
      (await loadTarget(targetPath(this.launch)));
    if (request?.identity && request.identity !== input.identity)
      throw new TargetError(
        "target-mismatch",
        "Expected checkout identity is stale or belongs to another target. Review the current target before retrying; no mutation began.",
      );
    let entry = this.entries.get(input.identity);
    if (!entry) {
      this.prune();
      if (this.entries.size >= 32)
        throw new TargetError(
          "target-capacity",
          "All retained checkout bindings are busy. Retry after an existing request completes; no target was changed.",
        );
      const verify = async () => {
        const bound = this.current();
        try {
          if (
            this.closed ||
            (await loadTarget(input.root)).identity !== input.identity
          )
            throw new Error("changed target");
        } catch {
          const failure = new TargetError(
            "target-changed",
            "Checkout identity, configuration or containment changed after source preparation. Inspect the intended checkout before retrying; no automatic retarget occurred.",
            bound?.writes ? "partial" : "unchanged",
          );
          if (bound) bound.targetFailure = failure;
          throw failure;
        }
      };
      const store = new GuardedStore(
        (input.store as LocalFileStore).root,
        verify,
        () => {
          const bound = this.current();
          if (bound) bound.writes++;
        },
        (error) => {
          const bound = this.current();
          const failure = new TargetError(
            error.code,
            error.message,
            bound?.writes ? "partial" : "unchanged",
          );
          if (bound) bound.targetFailure = failure;
          return failure;
        },
      );
      const fixed = { ...input, store };
      entry = {
        input: fixed,
        owner: new RepositoryOwner(async () => fixed, input.root),
        active: 0,
        telemetry: new Telemetry(input.root, "mcp"),
        coordinator: new GitWorktreeIdCoordinator(input.root),
      };
      this.entries.set(input.identity, entry);
    }
    entry.active++;
    return {
      owner: entry.owner,
      entry,
      mutation,
      writes: 0,
      receipt: {
        supported: true,
        root: input.root,
        identity: input.identity,
        selectedBy: requested
          ? "request"
          : pin
            ? "pin"
            : roots
              ? "client-roots"
              : "launch",
        rootsSupported: provider.supported,
        matched: true,
        intentConfirmed:
          requested !== undefined || pin !== undefined || roots !== undefined,
      },
    };
  }
  async run<T>(bound: BoundTarget, operation: () => Promise<T>): Promise<T> {
    try {
      return await this.scope.run(bound, operation);
    } finally {
      if (bound.entry) bound.entry.active--;
    }
  }
  private prune() {
    if (this.entries.size < 32) return;
    for (const [key, entry] of this.entries) {
      if (entry.active === 0) {
        entry.owner.close();
        this.entries.delete(key);
        return;
      }
    }
  }
  close() {
    this.closed = true;
    this.launchOwner.close();
    for (const entry of this.entries.values()) entry.owner.close();
    this.entries.clear();
    this.invalidateRoots();
  }
}
