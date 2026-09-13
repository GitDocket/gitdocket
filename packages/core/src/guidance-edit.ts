import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DocketConfig } from "./config";
import {
  DocumentEditError,
  editDocument,
  readEditableDocument,
} from "./document-edit";
import { type FileStore, InMemoryFileStore, LocalFileStore } from "./filestore";
import { PROJECT_GUIDANCE_PATH } from "./guidance";
import { mutate } from "./ops";

/** A missing entry point is a draft, not a file created by a read. */
const ABSENT_VERSION = "0".repeat(64);
const template =
  "---\ntype: Reference\ntitle: Project guidance\ndescription: Project-authored standards and scoped procedure links.\n---\n\n";
const virtualStore = () =>
  new InMemoryFileStore(new Map([[PROJECT_GUIDANCE_PATH, template]]));

async function absent(store: FileStore): Promise<boolean> {
  if (store instanceof LocalFileStore) {
    try {
      await lstat(join(store.root, PROJECT_GUIDANCE_PATH));
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
  }
  return !(await store.list()).includes(PROJECT_GUIDANCE_PATH);
}

export async function readEditableGuidance(
  store: FileStore,
  config: DocketConfig,
) {
  if (!(await absent(store)))
    return readEditableDocument(store, config, PROJECT_GUIDANCE_PATH);
  return {
    ...(await readEditableDocument(
      virtualStore(),
      config,
      PROJECT_GUIDANCE_PATH,
    )),
    version: ABSENT_VERSION,
  };
}

/** Only the fixed optional entry point can be created through the shared editor. */
export async function editGuidance(
  store: FileStore,
  config: DocketConfig,
  request: unknown,
) {
  if (
    !request ||
    typeof request !== "object" ||
    !("expectedVersion" in request) ||
    request.expectedVersion !== ABSENT_VERSION
  )
    return editDocument(store, config, PROJECT_GUIDANCE_PATH, request);
  // Use the shared validator and patcher before touching the real store.
  const memory = virtualStore();
  const base = await readEditableDocument(
    memory,
    config,
    PROJECT_GUIDANCE_PATH,
  );
  const result = await editDocument(memory, config, PROJECT_GUIDANCE_PATH, {
    ...request,
    expectedVersion: base.version,
  });
  const source = await memory.read(PROJECT_GUIDANCE_PATH);
  return mutate(store, async () => {
    const conflict = () =>
      new DocumentEditError(
        "conflict",
        "Project guidance was created since this draft opened. Review the latest source before saving.",
      );
    if (!(await absent(store))) throw conflict();
    if (store instanceof LocalFileStore) {
      const root = await realpath(store.root);
      const directory = join(root, "reference");
      try {
        await mkdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if ((await realpath(directory)) !== directory)
        throw new DocumentEditError(
          "invalid",
          "Guidance creation requires a reference directory inside the bundle, without a symlink.",
        );
      try {
        await writeFile(join(directory, "project-guidance.md"), source, {
          encoding: "utf8",
          flag: "wx",
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw conflict();
        throw error;
      }
    } else await store.write(PROJECT_GUIDANCE_PATH, source);
    return {
      ...result,
      paths: [PROJECT_GUIDANCE_PATH],
      changed: true,
      taskId: null,
    };
  });
}
