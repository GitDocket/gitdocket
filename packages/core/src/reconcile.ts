/** Reviewed, local-only Docket reconciliation. Git supplies evidence, never writes history. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { parse as yaml } from "yaml";
import { z } from "zod";
import { loadBundle } from "./bundle";
import { type DocketConfig, parseConfig } from "./config";
import { type FileStore, InMemoryFileStore, LocalFileStore } from "./filestore";
import { applyIndex, renderIndex } from "./indexmd";
import { mutate } from "./ops";
import { markdownSection, parseConcept } from "./parse";
import { buildSchemas } from "./schema";
import { canTransitionWorkItem, isTerminalStatus } from "./states";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const token = z.string().regex(/^[a-f0-9]{64}$/);
const MAX_SOURCE = 64 * 1024;
const MAX_INDEX = 512 * 1024;
const MAX_BUNDLE = 8 * 1024 * 1024;
const run = promisify(execFile);
export class ReconcileError extends Error {
  readonly mutation = "unchanged";
  constructor(
    readonly code:
      | "invalid-request"
      | "source-conflict"
      | "unavailable"
      | "unsupported",
    message: string,
  ) {
    super(message);
  }
}
function fail(code: ReconcileError["code"], message: string): never {
  throw new ReconcileError(code, message);
}
function requestValue<T extends z.ZodType>(
  schema: T,
  value: unknown,
): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success)
    fail(
      "invalid-request",
      "Reconciliation request does not match its bounded schema.",
    );
  return result.data;
}
export const reconcileSelectionSchema = z
  .object({
    sourceRef: z.string().min(1).max(256),
    sourceRoot: z.string().max(2048).optional(),
    saved: z.boolean().optional().default(false),
    baseRef: z.string().min(1).max(256).optional(),
    paths: z.array(z.string().max(256)).min(1).max(32),
  })
  .strict();
export type ReconcileSelection = z.input<typeof reconcileSelectionSchema>;
const choice = z
  .object({
    path: z.string().max(256),
    disposition: z.enum([
      "keep-local",
      "merge-compatible",
      "take-incoming",
      "resolve",
    ]),
    reason: z.string().trim().min(1).max(512).optional(),
    source: z.string().max(MAX_SOURCE).optional(),
    acceptCompletion: z.boolean().optional(),
  })
  .strict();
export const reconcileApplySchema = z
  .object({
    selection: reconcileSelectionSchema,
    expectedVersion: token,
    choices: z.array(choice).min(1).max(32),
  })
  .strict();
type Choice = z.infer<typeof choice>;
type Row = {
  path: string;
  classification:
    | "unchanged"
    | "compatible"
    | "independent-log"
    | "derived-index"
    | "semantic-review"
    | "conflict"
    | "collision"
    | "unavailable";
  base: string | null;
  local: string | null;
  incoming: string | null;
  proposed: string | null;
  semantic: string[];
  untracked: boolean;
};
type Data = {
  selection: z.infer<typeof reconcileSelectionSchema>;
  version: string;
  identity: string;
  sourceIdentity: string | null;
  config: DocketConfig;
  localHead: string;
  sourceHead: string;
  baseline: string;
  files: Map<string, string>;
  rows: Row[];
};

function safePath(path: string) {
  if (
    !path.endsWith(".md") ||
    isAbsolute(path) ||
    /[\\\0\r\n:]/.test(path) ||
    path.split("/").some((part) => !part || part.startsWith("."))
  )
    fail(
      "invalid-request",
      "Select visible bundle-relative Markdown paths without traversal.",
    );
}
async function contained(root: string, path: string) {
  let cursor = root;
  for (const part of path.split("/")) {
    cursor = join(cursor, part);
    try {
      if ((await lstat(cursor)).isSymbolicLink())
        fail("unsupported", "Reconciliation cannot follow filesystem links.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}
async function safeRead(
  store: FileStore,
  path: string,
  limit = MAX_SOURCE,
): Promise<string | null> {
  if (!(store instanceof LocalFileStore))
    fail(
      "unsupported",
      "Reconciliation requires a selected local repository store.",
    );
  await contained(store.root, path);
  try {
    const size = (await lstat(join(store.root, path))).size;
    if (size > limit)
      fail("unsupported", "Source exceeds the supported byte limit.");
    const source = await store.read(path);
    if (Buffer.byteLength(source) > limit)
      fail("unsupported", "Source exceeds the supported byte limit.");
    return source;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
async function git(root: string, args: string[], allowMissing = false) {
  try {
    return (
      await run("git", ["-c", "core.fsmonitor=false", ...args], {
        cwd: root,
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: MAX_BUNDLE,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
          GIT_PAGER: "cat",
        },
      })
    ).stdout;
  } catch (error) {
    // Only a missing exact object path is optional, never a failed repository query.
    if (
      allowMissing &&
      (error as { code?: unknown }).code === 128 &&
      /does not exist|exists on disk, but not in/.test(
        String((error as { stderr?: unknown }).stderr),
      )
    )
      return null;
    fail(
      "unavailable",
      "Local Git evidence is unavailable or exceeded its time/byte limit; no source was written.",
    );
  }
}
async function revision(root: string, ref: string) {
  const value = (
    await git(root, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${ref}^{commit}`,
    ])
  )?.trim();
  if (!value || !/^[a-f0-9]{40,64}$/.test(value))
    fail("unavailable", "A selected local commit could not be resolved.");
  return value;
}
async function committed(
  root: string,
  revision: string,
  path: string,
  limit = MAX_SOURCE,
) {
  const value = await git(root, ["show", `${revision}:${path}`], true);
  if (value !== null && Buffer.byteLength(value) > limit)
    fail("unsupported", "Committed source exceeds its byte limit.");
  return value;
}
function validatedConfig(source: string | null) {
  if (!source || Buffer.byteLength(source) > MAX_SOURCE)
    fail(
      "unavailable",
      "A source/baseline configuration is missing or oversized.",
    );
  const raw = yaml(source);
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    fail("unavailable", "Source configuration must be a YAML mapping.");
  const config = parseConfig(source);
  for (const key of ["project", "bundle"])
    if (key in raw && (typeof raw[key] !== "string" || !raw[key].trim()))
      fail("unavailable", "Known configuration values must have valid types.");
  for (const key of ["ids", "workflow", "git"])
    if (
      key in raw &&
      (!raw[key] || typeof raw[key] !== "object" || Array.isArray(raw[key]))
    )
      fail("unavailable", "Known configuration sections must be mappings.");
  const bundle = config.bundle.replace(/\/$/, "");
  if (
    isAbsolute(bundle) ||
    /[\\\0\r\n:]/.test(bundle) ||
    bundle.split("/").some((part) => !part || part.startsWith("."))
  )
    fail(
      "unsupported",
      "Bundle configuration is not a supported relative directory.",
    );
  return config;
}
async function identity(root: string, store: LocalFileStore) {
  await contained(root, "docket.yaml");
  await contained(root, relative(root, store.root));
  const stat = await lstat(store.root);
  if (!stat.isDirectory())
    fail("unavailable", "The selected bundle is unavailable.");
  return hash(
    JSON.stringify([
      await realpath(root),
      await realpath(store.root),
      stat.dev,
      stat.ino,
      hash(await readFile(join(root, "docket.yaml"), "utf8")),
    ]),
  );
}
async function inventory(store: FileStore) {
  const paths = (await store.list()).sort();
  if (paths.length > 2048)
    fail("unsupported", "Bundle inventory exceeds 2048 Markdown sources.");
  let bytes = 0;
  const files = new Map<string, string>();
  for (const path of paths) {
    safePath(path);
    const source = await safeRead(store, path, MAX_BUNDLE);
    if (source === null)
      fail(
        "source-conflict",
        "Bundle inventory changed during reconciliation.",
      );
    bytes += Buffer.byteLength(source);
    if (bytes > MAX_BUNDLE)
      fail("unsupported", "Bundle source inventory exceeds 8 MiB.");
    files.set(path, source);
  }
  return files;
}
function additions(
  base: string,
  local: string,
  incoming: string,
): string | null {
  if (local === incoming) return local;
  const prefix = local.startsWith(base) && incoming.startsWith(base);
  const suffix =
    base.length > 0 && local.endsWith(base) && incoming.endsWith(base);
  if (!prefix && !suffix) return null;
  const left = prefix ? local.slice(base.length) : local.slice(0, -base.length);
  const right = prefix
    ? incoming.slice(base.length)
    : incoming.slice(0, -base.length);
  // Conventional blank-line separated entries only. Preserve original bytes;
  // suppress exact duplicate additions, never rank or rewrite their narratives.
  const seen = new Set(left.trim().split(/\n\s*\n/));
  const fresh = right
    .trim()
    .split(/\n\s*\n/)
    .filter((entry) => entry && !seen.has(entry));
  const merged =
    left +
    (fresh.length
      ? `${left.endsWith("\n\n") ? "" : "\n\n"}${fresh.join("\n\n")}\n\n`
      : "");
  return prefix ? base + merged : merged + base;
}
function logSlice(source: string) {
  const match = /^# Log\s*\r?\n/m.exec(source);
  if (!match || match.index === undefined) return null;
  const start = match.index + match[0].length;
  const endMatch = /^# /m.exec(source.slice(start));
  const end = endMatch ? start + endMatch.index : source.length;
  return {
    head: source.slice(0, start),
    log: source.slice(start, end),
    tail: source.slice(end),
  };
}
async function merge(
  base: string,
  local: string,
  incoming: string,
): Promise<{ source: string | null; logs: boolean }> {
  if (local === base) return { source: incoming, logs: false };
  if (incoming === base || local === incoming)
    return { source: local, logs: false };
  const b = logSlice(base),
    l = logSlice(local),
    i = logSlice(incoming);
  const logs = b && l && i ? additions(b.log, l.log, i.log) : null;
  const directory = await mkdtemp(join(tmpdir(), "docket-reconcile-"));
  try {
    const values =
      logs === null
        ? [local, base, incoming]
        : [
            l?.head + (l?.tail ?? ""),
            b?.head + (b?.tail ?? ""),
            i?.head + (i?.tail ?? ""),
          ];
    const paths = ["local", "base", "incoming"].map((name) =>
      join(directory, name),
    );
    await Promise.all(paths.map((path, n) => writeFile(path, values[n] ?? "")));
    let source: string;
    try {
      source = (
        await run("git", ["merge-file", "-p", ...paths], {
          encoding: "utf8",
          timeout: 5000,
          maxBuffer: MAX_SOURCE * 4,
        })
      ).stdout;
    } catch (error) {
      if (
        typeof (error as { code?: unknown }).code === "number" &&
        Number((error as { code: number }).code) > 0 &&
        Number((error as { code: number }).code) < 128
      )
        return { source: null, logs: false };
      fail(
        "unavailable",
        "Three-way source comparison failed; no source was written.",
      );
    }
    if (logs !== null) {
      const slice = logSlice(source);
      if (!slice) return { source: null, logs: false };
      source = slice.head + logs + slice.tail;
    }
    return { source, logs: logs !== null };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
function semanticChanges(
  path: string,
  base: string | null,
  incoming: string | null,
): string[] {
  if (incoming === base) return [];
  if (
    /^(?:workflows\/|extensions\/|reference\/project-guidance\.md$)/.test(path)
  )
    return ["guidance"];
  const fm = (source: string | null) =>
    source?.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  const before = fm(base),
    after = fm(incoming);
  const a = before ? yaml(before) : {},
    b = after ? yaml(after) : {};
  if (
    !a ||
    !b ||
    typeof a !== "object" ||
    typeof b !== "object" ||
    Array.isArray(a) ||
    Array.isArray(b)
  )
    return ["frontmatter"];
  const changes = Object.keys({ ...a, ...b })
    .filter(
      (key) =>
        !["timestamp", "title", "description"].includes(key) &&
        !isDeepStrictEqual(a[key], b[key]),
    )
    .map((key) => `field:${key}`);
  for (const heading of ["Outcome", "Acceptance Criteria"])
    if (
      markdownSection(base ?? "", heading) !==
      markdownSection(incoming ?? "", heading)
    )
      changes.push(heading);
  return changes;
}
async function build(
  store: FileStore,
  config: DocketConfig,
  root: string,
  request: unknown,
): Promise<Data> {
  const selection = requestValue(reconcileSelectionSchema, request);
  if (!(store instanceof LocalFileStore))
    fail("unsupported", "Reconciliation requires a selected local checkout.");
  if (new Set(selection.paths).size !== selection.paths.length)
    fail("invalid-request", "Selected paths must be unique.");
  selection.paths.forEach(safePath);
  const sourceRoot = selection.sourceRoot ?? root;
  if (!isAbsolute(root) || !isAbsolute(sourceRoot))
    fail("invalid-request", "Selected checkout roots must be absolute.");
  const ownConfig = validatedConfig(
    await readFile(join(root, "docket.yaml"), "utf8"),
  );
  if (
    !isDeepStrictEqual(ownConfig, config) ||
    resolve(root, config.bundle) !== resolve(store.root)
  )
    fail(
      "source-conflict",
      "Selected configuration or bundle binding changed.",
    );
  const common = async (r: string) =>
    realpath(
      resolve(
        r,
        (await git(r, ["rev-parse", "--git-common-dir"]))?.trim() ?? "",
      ),
    );
  if ((await common(root)) !== (await common(sourceRoot)))
    fail(
      "unsupported",
      "Sources must belong to the same local Git repository.",
    );
  for (const selected of [root, sourceRoot])
    if (
      (await git(selected, ["rev-parse", "--show-toplevel"]))?.trim() !==
      (await realpath(selected))
    )
      fail(
        "unsupported",
        "Reconciliation currently requires docket.yaml at each selected Git checkout root.",
      );
  const localHead = await revision(root, "HEAD"),
    sourceHead = await revision(sourceRoot, selection.sourceRef);
  if (selection.saved && sourceHead !== (await revision(sourceRoot, "HEAD")))
    fail(
      "invalid-request",
      "Saved worktree sources require sourceRef to resolve to that worktree's HEAD.",
    );
  const baseline = selection.baseRef
    ? await revision(root, selection.baseRef)
    : (await git(root, ["merge-base", localHead, sourceHead]))?.trim();
  if (!baseline || !/^[a-f0-9]{40,64}$/.test(baseline))
    fail("unavailable", "No shared local baseline is available.");
  await git(root, ["merge-base", "--is-ancestor", baseline, localHead]);
  await git(root, ["merge-base", "--is-ancestor", baseline, sourceHead]);
  const bundlePath = config.bundle.replace(/\/$/, "");
  const sourceConfigText = selection.saved
    ? await readFile(join(sourceRoot, "docket.yaml"), "utf8")
    : await committed(sourceRoot, sourceHead, "docket.yaml");
  const sourceConfig = validatedConfig(sourceConfigText),
    baseConfig = validatedConfig(
      await committed(root, baseline, "docket.yaml"),
    );
  if (
    !isDeepStrictEqual(sourceConfig, config) ||
    !isDeepStrictEqual(baseConfig, config)
  )
    fail(
      "unsupported",
      "Source/baseline configuration differs; review configuration separately before reconciling sources.",
    );
  const selectedIdentity = await identity(root, store);
  const files = await inventory(store);
  const tracked = new Set(
    (await git(root, ["ls-files", "-z", "--", `${bundlePath}/`]))
      ?.split("\0")
      .filter(Boolean),
  );
  const sourceStore = new LocalFileStore(join(sourceRoot, sourceConfig.bundle));
  const sourceIdentity = selection.saved
    ? await identity(sourceRoot, sourceStore)
    : null;
  const rows: Row[] = [];
  for (const path of selection.paths) {
    const limit = path === "index.md" ? MAX_INDEX : MAX_SOURCE;
    const base = await committed(
      root,
      baseline,
      `${bundlePath}/${path}`,
      limit,
    );
    const incoming = selection.saved
      ? await safeRead(sourceStore, path, limit)
      : await committed(sourceRoot, sourceHead, `${bundlePath}/${path}`, limit);
    const local = files.get(path) ?? null;
    if (local !== null && Buffer.byteLength(local) > limit)
      fail("unsupported", "Selected local source exceeds its byte limit.");
    const semantic = semanticChanges(path, base, incoming);
    const untracked = local !== null && !tracked.has(`${bundlePath}/${path}`);
    let classification: Row["classification"],
      proposed = local;
    if (incoming === base || local === incoming) classification = "unchanged";
    else if (incoming === null) classification = "unavailable";
    else if (untracked || (base === null && local !== null))
      classification = "collision";
    else if (path === "index.md") {
      const compared = await merge(
        applyIndex(base ?? "", ""),
        applyIndex(local ?? "", ""),
        applyIndex(incoming, ""),
      );
      proposed = compared.source;
      classification = proposed === null ? "conflict" : "derived-index";
    } else {
      const compared = await merge(base ?? "", local ?? "", incoming);
      proposed = compared.source;
      classification =
        proposed === null
          ? "conflict"
          : semantic.length
            ? "semantic-review"
            : compared.logs
              ? "independent-log"
              : "compatible";
    }
    rows.push({
      path,
      classification,
      base,
      local,
      incoming,
      proposed,
      semantic,
      untracked,
    });
  }
  const localIdentities = new Map<string, string[]>();
  for (const [path, source] of files) {
    const concept = parseConcept(path, source, buildSchemas(config)).concept;
    if (!concept) continue;
    const ids = [
      ...(concept.kind === "generic" ? [] : [concept.fm.id]),
      ...concept.fm.aliases,
    ];
    for (const id of ids)
      localIdentities.set(id, [...(localIdentities.get(id) ?? []), path]);
  }
  for (const row of rows) {
    if (row.incoming === row.local || row.incoming === null) continue;
    const incoming = parseConcept(row.path, row.incoming, buildSchemas(config));
    if (incoming.diagnostics.some((d) => d.severity === "error")) {
      row.classification = "unavailable";
      continue;
    }
    const concept = incoming.concept;
    const ids = concept
      ? [
          ...(concept.kind === "generic" ? [] : [concept.fm.id]),
          ...concept.fm.aliases,
        ]
      : [];
    if (
      ids.some((id) =>
        localIdentities.get(id)?.some((path) => path !== row.path),
      )
    )
      row.classification = "collision";
  }
  // Recheck all recipient bytes and evidence after reading. No mixed snapshot is reviewable.
  const stable = await inventory(store);
  if (
    !isDeepStrictEqual(stable, files) ||
    selectedIdentity !== (await identity(root, store)) ||
    localHead !== (await revision(root, "HEAD")) ||
    sourceHead !== (await revision(sourceRoot, selection.sourceRef))
  )
    fail(
      "source-conflict",
      "Inputs changed while planning; request a fresh plan.",
    );
  if (selection.saved) {
    if (sourceIdentity !== (await identity(sourceRoot, sourceStore)))
      fail(
        "source-conflict",
        "Saved source configuration or checkout changed while planning.",
      );
    for (const row of rows)
      if (
        row.incoming !==
        (await safeRead(
          sourceStore,
          row.path,
          row.path === "index.md" ? MAX_INDEX : MAX_SOURCE,
        ))
      )
        fail(
          "source-conflict",
          "Saved incoming source changed while planning.",
        );
  }
  const version = hash(
    JSON.stringify({
      selection,
      selectedIdentity,
      sourceIdentity,
      localHead,
      sourceHead,
      baseline,
      files: [...files].map(([path, source]) => [path, hash(source)]),
      rows,
    }),
  );
  return {
    selection,
    identity: selectedIdentity,
    sourceIdentity,
    version,
    config,
    localHead,
    sourceHead,
    baseline,
    files,
    rows,
  };
}
const versionOf = (value: string | null) =>
  value === null ? null : hash(value);
function rowView(row: Row, config: DocketConfig) {
  const parsed = row.incoming
    ? parseConcept(row.path, row.incoming, buildSchemas(config)).concept
    : undefined;
  const local = row.local
    ? parseConcept(row.path, row.local, buildSchemas(config)).concept
    : undefined;
  return {
    path: row.path,
    classification: row.classification,
    versions: {
      base: versionOf(row.base),
      local: versionOf(row.local),
      incoming: versionOf(row.incoming),
      proposed: versionOf(row.proposed),
    },
    semantic: row.semantic.slice(0, 12).map((label) => label.slice(0, 64)),
    semanticLabelsAbbreviated: row.semantic.some((label) => label.length > 64),
    omittedSemantic: Math.max(0, row.semantic.length - 12),
    untrackedDraft: row.untracked,
    ...(parsed?.kind === "work"
      ? {
          localStatus: local?.kind === "work" ? local.fm.status : null,
          incomingStatus: parsed.fm.status,
          acceptanceAvailable: !!parsed.outcome,
          epic: parsed.fm.epic?.slice(0, 256),
        }
      : {}),
  };
}
export async function planReconciliation(
  store: FileStore,
  config: DocketConfig,
  root: string,
  request: unknown,
  offset = 0,
) {
  if (!Number.isSafeInteger(offset) || offset < 0)
    fail("invalid-request", "Offset must be a nonnegative integer.");
  const data = await build(store, config, root, request);
  const items = data.rows
    .slice(offset, offset + 8)
    .map((row) => rowView(row, config));
  const bundle = await loadBundle(new InMemoryFileStore(data.files), config);
  const counts = bundle.workItems
    .filter((w) => w.fm.type === "Epic")
    .flatMap((epic) => {
      const children = bundle.workItems.filter(
        (w) => w.fm.type === "Task" && w.fm.epic === `/${epic.path}`,
      );
      if (!data.rows.some((row) => children.some((w) => w.path === row.path)))
        return [];
      const done = children.filter((w) => w.fm.status === "done").length;
      const proposedDone = children.filter((w) => {
        const row = data.rows.find((row) => row.path === w.path);
        const proposed = row?.proposed
          ? parseConcept(w.path, row.proposed, buildSchemas(config)).concept
          : undefined;
        return (
          (proposed?.kind === "work" ? proposed.fm.status : w.fm.status) ===
          "done"
        );
      }).length;
      return [
        {
          path: epic.path.slice(0, 256),
          localDone: done,
          total: children.length,
          proposedDone,
          authority: "preview-only",
        },
      ];
    });
  const result = {
    schema: "docket-reconcile-plan/v1",
    version: data.version,
    authority: "review-required",
    localHead: data.localHead,
    sourceHead: data.sourceHead,
    baseline: data.baseline,
    savedSource: data.selection.saved,
    total: data.rows.length,
    offset,
    items,
    omitted: 0,
    nextOffset: null as number | null,
    epicCounts: counts.slice(0, 4),
    omittedEpicCounts: Math.max(0, counts.length - 4),
    limits: {
      paths: 32,
      sourceBytes: MAX_SOURCE,
      indexBytes: MAX_INDEX,
      inventory: 2048,
      bundleBytes: MAX_BUNDLE,
      responseBytes: 8192,
    },
    instructions:
      "Review exact base/local/incoming/proposed pages with reconcile source. Supply one explicit disposition per selected path, a reason for semantic/conflicting choices, and acceptCompletion for terminal state imports. No Git/application merge or implementation integration proof is implied. Incoming deletions are unsupported; keep local source. Untracked drafts can only be kept or explicitly resolved from preserved originals.",
  };
  while (
    Buffer.byteLength(JSON.stringify(result, null, 2)) > 7600 &&
    items.length > 1
  )
    items.pop();
  while (
    Buffer.byteLength(JSON.stringify(result, null, 2)) > 7600 &&
    result.epicCounts.length
  ) {
    result.epicCounts.pop();
    result.omittedEpicCounts++;
  }
  result.omitted = data.rows.length - items.length;
  result.nextOffset =
    offset + items.length < data.rows.length ? offset + items.length : null;
  return result;
}
export async function readReconciliationSource(
  store: FileStore,
  config: DocketConfig,
  root: string,
  request: unknown,
  expectedVersion: string,
  path: string,
  side: "base" | "local" | "incoming" | "proposed",
  offset = 0,
) {
  requestValue(token, expectedVersion);
  if (!Number.isSafeInteger(offset) || offset < 0)
    fail("invalid-request", "Offset must be nonnegative.");
  const data = await build(store, config, root, request);
  if (data.version !== expectedVersion)
    fail("source-conflict", "Plan changed; review a fresh plan.");
  const row = data.rows.find((item) => item.path === path);
  if (!row) fail("invalid-request", "Path is outside the reviewed selection.");
  const source = row[side];
  if (source === null)
    return {
      path,
      side,
      available: false,
      version: null,
      offset,
      text: null,
      nextOffset: null,
    };
  if (
    offset > source.length ||
    (offset > 0 && /[\uDC00-\uDFFF]/.test(source[offset] ?? ""))
  )
    fail("invalid-request", "Source offset is invalid.");
  let end = Math.min(source.length, offset + 1600);
  if (end < source.length && /[\uDC00-\uDFFF]/.test(source[end] ?? "")) end--;
  const result = {
    path,
    side,
    available: true,
    version: hash(source),
    offset,
    text: source.slice(offset, end),
    nextOffset: end < source.length ? end : null,
  };
  while (
    Buffer.byteLength(JSON.stringify(result, null, 2)) > 7600 &&
    end > offset
  ) {
    end--;
    if (/[\uDC00-\uDFFF]/.test(source[end] ?? "")) end--;
    result.text = source.slice(offset, end);
    result.nextOffset = end < source.length ? end : null;
  }
  return result;
}
const changeSchema = z
  .object({
    path: z.string(),
    before: z.string().nullable(),
    after: z.string(),
  })
  .strict();
const journalSchema = z
  .object({
    schema: z.literal(1),
    identity: token,
    sourceIdentity: token.nullable(),
    planVersion: token,
    requestHash: token,
    config: z.unknown(),
    choices: z.array(choice),
    selection: reconcileSelectionSchema,
    localHead: z.string().regex(/^[a-f0-9]{40,64}$/),
    rows: z
      .array(
        z
          .object({
            path: z.string(),
            classification: z.enum([
              "unchanged",
              "compatible",
              "independent-log",
              "derived-index",
              "semantic-review",
              "conflict",
              "collision",
              "unavailable",
            ]),
            base: z.string().nullable(),
            local: z.string().nullable(),
            incoming: z.string().nullable(),
            proposed: z.string().nullable(),
            semantic: z.array(z.string()),
            untracked: z.boolean(),
          })
          .strict(),
      )
      .max(32),
    snapshot: z.array(z.object({ path: z.string(), version: token }).strict()),
    changes: z.array(changeSchema).max(33),
    sourceHead: z.string().regex(/^[a-f0-9]{40,64}$/),
    baseline: z.string().regex(/^[a-f0-9]{40,64}$/),
  })
  .strict();
type Journal = z.infer<typeof journalSchema>;
const journalPath = (token: string) => `.docket-reconcile/${token}.json`;
function requireStore(store: FileStore): asserts store is LocalFileStore {
  if (
    !(store instanceof LocalFileStore) ||
    !store.readOptional ||
    !store.createExclusive
  )
    fail(
      "unsupported",
      "Reconciliation requires a local store with exclusive creation and absence detection.",
    );
}
async function validateProjection(
  files: Map<string, string>,
  changes: { path: string; after: string }[],
  config: DocketConfig,
  choices: Choice[],
) {
  const projected = new Map(files);
  const schemas = buildSchemas(config);
  for (const change of changes) {
    safePath(change.path);
    if (
      Buffer.byteLength(change.after) >
      (change.path === "index.md" ? MAX_BUNDLE : MAX_SOURCE)
    )
      fail("unsupported", "Resolved source exceeds its byte limit.");
    const old = parseConcept(
      change.path,
      files.get(change.path) ?? "",
      schemas,
    ).concept;
    const parsed = parseConcept(change.path, change.after, schemas);
    if (parsed.diagnostics.some((d) => d.severity === "error"))
      fail("invalid-request", "Resolved source has invalid concept metadata.");
    const next = parsed.concept;
    if (old?.kind === "work" && next?.kind !== "work")
      fail(
        "unsupported",
        "Existing work identity cannot change during reconciliation.",
      );
    if (
      old?.kind === "decision" &&
      (next?.kind !== "decision" || old.fm.id !== next.fm.id)
    )
      fail(
        "unsupported",
        "Existing Decision identity cannot change during reconciliation.",
      );
    if (old?.kind === "work" && next?.kind === "work") {
      if (old.fm.id !== next.fm.id || old.fm.type !== next.fm.type)
        fail(
          "unsupported",
          "Existing work identity cannot change during reconciliation.",
        );
      if (old.fm.status !== next.fm.status) {
        if (
          !canTransitionWorkItem(
            old.fm.status,
            next.fm.status,
            old.fm.type,
            config.workflow.reopenClosed,
          )
        )
          fail(
            "invalid-request",
            "Reviewed status import violates the configured transition policy.",
          );
        const disposition = choices.find((c) => c.path === change.path);
        if (
          !disposition?.reason ||
          (isTerminalStatus(next.fm.status) && !disposition.acceptCompletion)
        )
          fail(
            "invalid-request",
            "Status imports require a review reason and terminal imports require acceptCompletion.",
          );
      }
    } else if (
      next?.kind === "work" &&
      isTerminalStatus(next.fm.status) &&
      (!choices.find((c) => c.path === change.path)?.acceptCompletion ||
        !choices.find((c) => c.path === change.path)?.reason)
    )
      fail(
        "invalid-request",
        "New terminal work records require a reason and explicit completion acceptance.",
      );
    projected.set(change.path, change.after);
  }
  const previous = await loadBundle(new InMemoryFileStore(files), config);
  const next = await loadBundle(new InMemoryFileStore(projected), config);
  const known = new Set(
    previous.diagnostics
      .filter((d) => d.severity === "error")
      .map((d) => JSON.stringify(d)),
  );
  if (
    next.diagnostics.some(
      (d) => d.severity === "error" && !known.has(JSON.stringify(d)),
    )
  )
    fail(
      "invalid-request",
      "Projection introduces invalid or duplicate identities; resolve them before applying.",
    );
  for (const change of changes) {
    const item = next.workItems.find((w) => w.path === change.path);
    if (
      item?.fm.epic &&
      !next.workItems.some(
        (w) => w.fm.type === "Epic" && `/${w.path}` === item.fm.epic,
      )
    )
      fail(
        "invalid-request",
        "Reviewed work has an unavailable local epic relationship.",
      );
    if (
      item?.fm.status === "done" &&
      previous.workItems.find((w) => w.path === change.path)?.fm.status !==
        "done" &&
      item.fm.depends_on.some((id) => next.byId(id)?.fm.status !== "done")
    )
      fail(
        "invalid-request",
        "Accepted completion has unfinished or unavailable local dependencies.",
      );
  }
  return { projected, bundle: next };
}
async function inspectJournal(
  store: LocalFileStore,
  config: DocketConfig,
  root: string,
  journal: Journal,
) {
  if (
    journal.identity !== (await identity(root, store)) ||
    !isDeepStrictEqual(journal.config, config)
  )
    fail(
      "source-conflict",
      "Recovery belongs to a different checkout or configuration.",
    );
  const planVersion = hash(
    JSON.stringify({
      selection: journal.selection,
      selectedIdentity: journal.identity,
      sourceIdentity: journal.sourceIdentity,
      localHead: journal.localHead,
      sourceHead: journal.sourceHead,
      baseline: journal.baseline,
      files: journal.snapshot.map((entry) => [entry.path, entry.version]),
      rows: journal.rows,
    }),
  );
  if (planVersion !== journal.planVersion)
    fail(
      "invalid-request",
      "Recovery source evidence does not match the reviewed plan version.",
    );
  const files = await inventory(store);
  if (
    journal.changes.every((change) => files.get(change.path) === change.after)
  )
    return files;
  if (journal.localHead !== (await revision(root, "HEAD")))
    fail(
      "source-conflict",
      "Recipient Git HEAD changed; review before pending recovery writes.",
    );
  const allowed = new Set([
    ...journal.snapshot.map((e) => e.path),
    ...journal.changes.map((e) => e.path),
  ]);
  if ([...files.keys()].some((path) => !allowed.has(path)))
    fail(
      "source-conflict",
      "New sources require review before recovery; originals remain preserved.",
    );
  const originals = new Map<string, string>();
  for (const path of allowed) {
    safePath(path);
    const current = files.get(path) ?? null;
    const change = journal.changes.find((entry) => entry.path === path);
    const entry = journal.snapshot.find((entry) => entry.path === path);
    if (
      change
        ? current !== change.before && current !== change.after
        : current === null || hash(current) !== entry?.version
    )
      fail(
        "source-conflict",
        "Source changed outside the reviewed operation; reconcile using retained original and planned bytes.",
      );
    const original = change ? change.before : current;
    if (original !== null) {
      if (!entry || hash(original) !== entry.version)
        fail(
          "invalid-request",
          "Recovery original does not match its snapshot.",
        );
      originals.set(path, original);
    } else if (entry)
      fail("invalid-request", "Recovery snapshot and original disagree.");
  }
  const rebuilt = await prepareChanges(
    originals,
    journal.rows,
    config,
    journal.choices,
  );
  if (!isDeepStrictEqual(rebuilt, journal.changes))
    fail(
      "invalid-request",
      "Recovery changes differ from reviewed dispositions and derived index content.",
    );
  return files;
}
async function execute(
  store: LocalFileStore,
  config: DocketConfig,
  root: string,
  journal: Journal,
  recoveryToken: string,
) {
  let writes = 0;
  try {
    await inspectJournal(store, config, root, journal);
    for (const change of journal.changes) {
      const current = await safeRead(
        store,
        change.path,
        change.path === "index.md" ? MAX_BUNDLE : MAX_SOURCE,
      );
      if (current === change.after) continue;
      if (
        journal.identity !== (await identity(root, store)) ||
        journal.localHead !== (await revision(root, "HEAD"))
      )
        fail(
          "source-conflict",
          "Checkout or recipient HEAD changed during application.",
        );
      if (current !== change.before)
        fail("source-conflict", "Selected source changed during application.");
      await contained(store.root, change.path);
      if (change.before === null) {
        if (!(await store.createExclusive(change.path, change.after)))
          fail("source-conflict", "A destination appeared during application.");
      } else await store.write(change.path, change.after);
      if (
        (await safeRead(
          store,
          change.path,
          change.path === "index.md" ? MAX_BUNDLE : MAX_SOURCE,
        )) !== change.after
      )
        fail("source-conflict", "Source readback differs after application.");
      writes++;
    }
    return {
      schema: "docket-reconcile-result/v1",
      state: writes ? "applied" : "noop",
      mutation: writes ? "applied" : "unchanged",
      writes,
      changedPaths: journal.changes.length,
      recoveryToken,
      journal: journalPath(recoveryToken),
      sourceHead: journal.sourceHead,
      baseline: journal.baseline,
      integration: "not-established",
    };
  } catch (error) {
    return {
      schema: "docket-reconcile-result/v1",
      state: "recovery_required",
      mutation: "unknown",
      writes,
      changedPaths: journal.changes.length,
      recoveryToken,
      journal: journalPath(recoveryToken),
      error: {
        code: error instanceof ReconcileError ? error.code : "write-failed",
        message: (error instanceof Error ? error.message : String(error)).slice(
          0,
          512,
        ),
      },
      integration: "not-established",
      nextAction:
        "Retain this receipt. Reconcile unrelated changes explicitly, then use reconcile recover with this token. Original and planned bytes are retained; no rollback is claimed.",
    };
  }
}
async function readJournal(store: LocalFileStore, recoveryToken: string) {
  requestValue(token, recoveryToken);
  await contained(store.root, journalPath(recoveryToken));
  if (
    (await lstat(join(store.root, journalPath(recoveryToken)))).size >
    MAX_BUNDLE * 2
  )
    fail("unsupported", "Recovery journal exceeds its byte limit.");
  const raw = await store.readOptional(journalPath(recoveryToken));
  if (!raw || Buffer.byteLength(raw) > MAX_BUNDLE * 2)
    fail("unavailable", "Recovery journal is missing or oversized.");
  const journal = journalSchema.parse(JSON.parse(raw));
  if (
    hash(
      JSON.stringify({
        expectedVersion: journal.planVersion,
        choices: journal.choices,
      }),
    ) !== recoveryToken ||
    journal.requestHash !== recoveryToken ||
    new Set(journal.snapshot.map((e) => e.path)).size !==
      journal.snapshot.length ||
    new Set(journal.changes.map((e) => e.path)).size !== journal.changes.length
  )
    fail("invalid-request", "Recovery token or journal inventory is invalid.");
  return journal;
}
async function prepareChanges(
  files: Map<string, string>,
  rows: Row[],
  config: DocketConfig,
  choices: Choice[],
) {
  if (
    new Set(choices.map((c) => c.path)).size !== choices.length ||
    choices.length !== rows.length
  )
    fail(
      "invalid-request",
      "Provide exactly one disposition for every selected path.",
    );
  const changes: Journal["changes"] = [];
  for (const row of rows) {
    const selected = choices.find((c) => c.path === row.path);
    if (!selected)
      fail("invalid-request", "A selected path has no disposition.");
    if (selected.disposition === "keep-local") continue;
    if (row.classification === "unavailable")
      fail(
        "unsupported",
        "Incoming deletions or missing sources cannot be applied implicitly.",
      );
    if (row.untracked && selected.disposition !== "resolve")
      fail(
        "source-conflict",
        "An untracked draft requires explicit resolution; original bytes will be retained.",
      );
    if (
      (row.semantic.length ||
        ["conflict", "collision"].includes(row.classification)) &&
      !selected.reason
    )
      fail(
        "invalid-request",
        "Semantic/conflicting dispositions require a review reason.",
      );
    if (
      selected.disposition === "merge-compatible" &&
      !["unchanged", "compatible", "independent-log", "derived-index"].includes(
        row.classification,
      )
    )
      fail(
        "invalid-request",
        "This path requires an explicit semantic/conflict disposition.",
      );
    const after =
      selected.disposition === "resolve"
        ? selected.source
        : selected.disposition === "take-incoming"
          ? row.incoming
          : row.proposed;
    if (typeof after !== "string")
      fail("invalid-request", "Selected disposition has no complete source.");
    if (semanticChanges(row.path, row.local, after).length && !selected.reason)
      fail(
        "invalid-request",
        "Overriding local semantic content requires an explicit review reason.",
      );
    if (after !== row.local)
      changes.push({ path: row.path, before: row.local, after });
  }
  const projection = await validateProjection(files, changes, config, choices);
  if (changes.length) {
    const existing = changes.find((c) => c.path === "index.md");
    const after = applyIndex(
      projection.projected.get("index.md") ?? "",
      renderIndex(projection.bundle),
    );
    if (existing) existing.after = after;
    else if (after !== files.get("index.md"))
      changes.push({
        path: "index.md",
        before: files.get("index.md") ?? null,
        after,
      });
  }
  return changes;
}
export async function applyReconciliation(
  store: FileStore,
  config: DocketConfig,
  root: string,
  request: unknown,
) {
  const input = requestValue(reconcileApplySchema, request);
  const recoveryToken = hash(
    JSON.stringify({
      expectedVersion: input.expectedVersion,
      choices: input.choices,
    }),
  );
  return mutate(store, async () => {
    requireStore(store);
    await contained(store.root, journalPath(recoveryToken));
    if (await store.readOptional(journalPath(recoveryToken))) {
      const journal = await readJournal(store, recoveryToken);
      if (!isDeepStrictEqual(journal.selection, input.selection))
        fail(
          "invalid-request",
          "Retry selection differs from the reviewed journal.",
        );
      return execute(store, config, root, journal, recoveryToken);
    }
    const data = await build(store, config, root, input.selection);
    if (data.version !== input.expectedVersion)
      fail(
        "source-conflict",
        "Reviewed plan is stale; request a fresh plan before applying.",
      );
    const changes = await prepareChanges(
      data.files,
      data.rows,
      config,
      input.choices,
    );
    const sourceRoot = data.selection.sourceRoot ?? root;
    if (
      data.sourceHead !== (await revision(sourceRoot, data.selection.sourceRef))
    )
      fail(
        "source-conflict",
        "Selected incoming ref changed before application.",
      );
    if (data.selection.saved) {
      const sourceStore = new LocalFileStore(join(sourceRoot, config.bundle));
      if (data.sourceIdentity !== (await identity(sourceRoot, sourceStore)))
        fail(
          "source-conflict",
          "Selected saved checkout changed before application.",
        );
      for (const row of data.rows)
        if (
          row.incoming !==
          (await safeRead(
            sourceStore,
            row.path,
            row.path === "index.md" ? MAX_INDEX : MAX_SOURCE,
          ))
        )
          fail(
            "source-conflict",
            "Selected saved source changed before application.",
          );
    }
    if (!changes.length)
      return {
        schema: "docket-reconcile-result/v1",
        state: "noop",
        mutation: "unchanged",
        writes: 0,
        changedPaths: 0,
        sourceHead: data.sourceHead,
        baseline: data.baseline,
        integration: "not-established",
      };
    const journal: Journal = {
      schema: 1,
      identity: data.identity,
      sourceIdentity: data.sourceIdentity,
      config,
      planVersion: data.version,
      requestHash: recoveryToken,
      choices: input.choices,
      selection: data.selection,
      localHead: data.localHead,
      rows: data.rows,
      snapshot: [...data.files].map(([path, source]) => ({
        path,
        version: hash(source),
      })),
      changes,
      sourceHead: data.sourceHead,
      baseline: data.baseline,
    };
    if (
      !(await store.createExclusive(
        journalPath(recoveryToken),
        JSON.stringify(journal),
      ))
    )
      fail(
        "source-conflict",
        "Recovery journal appeared; retry the same reviewed request.",
      );
    return execute(store, config, root, journal, recoveryToken);
  });
}
export async function recoverReconciliation(
  store: FileStore,
  config: DocketConfig,
  root: string,
  recoveryToken: string,
) {
  return mutate(store, async () => {
    requireStore(store);
    return execute(
      store,
      config,
      root,
      await readJournal(store, recoveryToken),
      recoveryToken,
    );
  });
}
