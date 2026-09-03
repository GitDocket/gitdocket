import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  applyIndex,
  type Bundle,
  type DocketConfig,
  type LocalFileStore,
  renderIndex,
} from "@docket/core";
import { buildCache, scanActivity } from "@docket/core/cache";
import { scanRepoMarkers } from "./verify";

export interface IndexRefreshResult {
  indexChanged: boolean;
  verifyMarkerCount: number;
}

/** The one write path shared by `docket index` and init's final index pass. */
export async function refreshIndex(
  root: string,
  store: LocalFileStore,
  config: DocketConfig,
  bundle: Bundle,
): Promise<IndexRefreshResult> {
  const current = await store.read("index.md").catch(() => "");
  const next = applyIndex(current, renderIndex(bundle));
  if (next !== current) await store.write("index.md", next);

  await mkdir(join(root, ".docket"), { recursive: true });
  const markers = await scanRepoMarkers(root, config, bundle);
  const db = new Database(join(root, ".docket", "cache.sqlite"));
  try {
    buildCache(
      db,
      bundle,
      scanActivity(root, config.git.trailer, bundle.byId),
      markers,
    );
  } finally {
    db.close();
  }

  return {
    indexChanged: next !== current,
    verifyMarkerCount: markers.filter((marker) => marker.spec).length,
  };
}
