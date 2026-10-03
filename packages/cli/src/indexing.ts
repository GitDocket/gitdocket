import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  applyIndex,
  DOCKET_VERSION,
  type DocketConfig,
  isReserved,
  type LocalFileStore,
  loadBundle,
  renderIndex,
} from "@gitdocket/core";
import {
  buildCache,
  CACHE_SCHEMA_VERSION,
  scanActivityResult,
} from "@gitdocket/core/cache";
import { scanRepoMarkers } from "./verify";

export interface IndexRefreshResult {
  indexChanged: boolean;
  version: string;
  verifyMarkerCount: number;
  changed: boolean;
  paths: string[];
  cache: "rebuilt" | "unchanged";
  refresh: {
    policy: "fresh-derived-inputs/v1";
    inputVersion: string;
    git: "available" | "unavailable";
    reason:
      | "requested-rebuild"
      | "matching-inputs-and-cache"
      | "changed-or-unavailable-evidence";
    work: {
      markerScans: number;
      gitScans: number;
      cacheBuilds: number;
      indexWrites: number;
      cacheWrites: number;
    };
  };
}

const hash = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
// Only small owned receipts and bounded regular cache files can justify reuse.
async function cacheDigest(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > 256 * 1024 * 1024)
    throw new Error("Cache identity unavailable.");
  return hash(await readFile(path));
}

/** The one write path shared by `docket index` and init's final index pass. */
export async function refreshIndex(
  root: string,
  store: LocalFileStore,
  config: DocketConfig,
  options: {
    rebuild?: boolean;
    beforePublish?: () => Promise<void>;
    afterCachePublish?: () => Promise<void>;
  } = {},
): Promise<IndexRefreshResult> {
  return store.withMutation(async () => {
    const sources = new Map<string, string>();
    const bundle = await loadBundle(
      {
        list: () => store.list(),
        write: (path, content) => store.write(path, content),
        read: async (path) => {
          for (let attempt = 0; attempt < 3; attempt++) {
            const before = await store.version(path);
            const source = await store.read(path);
            if (before === (await store.version(path))) {
              sources.set(path, source);
              return source;
            }
          }
          throw new Error(
            `Source changed repeatedly during index refresh: ${path}`,
          );
        },
      },
      config,
    );
    const current = (await store.readOptional("index.md")) ?? "";
    const next = applyIndex(current, renderIndex(bundle));
    if (next !== current) await store.write("index.md", next);

    await mkdir(join(root, ".docket"), { recursive: true });
    const markers = await scanRepoMarkers(root, config, bundle);
    const activity = scanActivityResult(root, config.git.trailer, bundle.byId);
    const inputVersion = hash(
      JSON.stringify({
        contract: "docket-sqlite-refresh/v1",
        engineVersion: DOCKET_VERSION,
        cacheSchemaVersion: CACHE_SCHEMA_VERSION,
        config,
        sources: [...sources]
          .sort(([a], [b]) => a.localeCompare(b))
          .filter(([path]) => !isReserved(path))
          .map(([path, source]) => [path, hash(source)]),
        markers,
        activity,
      }),
    );
    const cachePath = join(root, ".docket/cache.sqlite");
    const receiptPath = join(root, ".docket/cache-refresh.json");
    let reusable = false;
    if (!options.rebuild && activity.status === "available") {
      try {
        const receiptInfo = await lstat(receiptPath);
        if (!receiptInfo.isFile() || receiptInfo.size > 4096)
          throw new Error("Refresh receipt unavailable.");
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        reusable =
          receipt.schema === "docket-cache-refresh/v1" &&
          receipt.inputVersion === inputVersion &&
          receipt.cacheVersion === (await cacheDigest(cachePath));
      } catch {
        /* Missing, changed, corrupt or interrupted derived state requires rebuilding. */
      }
    }
    if (!reusable) {
      const temp = `${cachePath}.${randomUUID()}.tmp`;
      const receiptTemp = `${receiptPath}.${randomUUID()}.tmp`;
      try {
        const db = new Database(temp);
        try {
          buildCache(db, bundle, activity.rows, markers);
        } finally {
          db.close();
        }
        const cacheVersion = await cacheDigest(temp);
        await options.beforePublish?.();
        await rename(temp, cachePath);
        await options.afterCachePublish?.();
        await writeFile(
          receiptTemp,
          `${JSON.stringify({ schema: "docket-cache-refresh/v1", inputVersion, cacheVersion })}\n`,
          { mode: 0o600, flag: "wx" },
        );
        await rename(receiptTemp, receiptPath);
      } finally {
        await rm(temp, { force: true });
        await rm(receiptTemp, { force: true });
      }
    }

    return {
      indexChanged: next !== current,
      version: createHash("sha256").update(next).digest("hex"),
      verifyMarkerCount: markers.filter((marker) => marker.spec).length,
      changed: next !== current || !reusable,
      paths: [
        ...(next !== current ? ["index.md"] : []),
        ...(!reusable
          ? [".docket/cache.sqlite", ".docket/cache-refresh.json"]
          : []),
      ],
      cache: reusable ? "unchanged" : "rebuilt",
      refresh: {
        policy: "fresh-derived-inputs/v1",
        inputVersion,
        git: activity.status,
        reason: options.rebuild
          ? "requested-rebuild"
          : reusable
            ? "matching-inputs-and-cache"
            : "changed-or-unavailable-evidence",
        work: {
          markerScans: config.verify ? 1 : 0,
          gitScans: 1,
          cacheBuilds: reusable ? 0 : 1,
          indexWrites: next !== current ? 1 : 0,
          cacheWrites: reusable ? 0 : 2,
        },
      },
    };
  });
}
