// One owner-authorized exception for the already-built 0.6.3 candidate.
// This imports exact bytes; it never builds, executes, or qualifies the product.
import assert from "node:assert/strict";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { DOCKET_VERSION } from "../packages/core/src/version";

export interface OwnerTestException {
  kind: "owner-requested-test-skip";
  version: "0.6.3";
  policySha256: string;
  productSourceCommit: string;
  checks: "SKIPPED_BY_OWNER_REQUEST";
}
interface ExceptionPolicy {
  schema: "gitdocket-owner-test-exception/v1";
  version: "0.6.3";
  sourceCommit: string;
  exportSha256: string;
  checks: "SKIPPED_BY_OWNER_REQUEST";
  publicationOverlay: Record<string, string>;
  assets: Record<string, string>;
  packageIntegrities: Record<string, string>;
}
const digest = (bytes: Uint8Array | string) =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
async function policyAt(root: string) {
  if (DOCKET_VERSION !== "0.6.3") return null;
  const file = Bun.file(join(root, "release/owner-exceptions/v0.6.3.json"));
  if (!(await file.exists())) return null;
  const body = await file.text();
  const policy: ExceptionPolicy = JSON.parse(body);
  assert.equal(policy.schema, "gitdocket-owner-test-exception/v1");
  assert.equal(policy.version, DOCKET_VERSION);
  assert.equal(policy.checks, "SKIPPED_BY_OWNER_REQUEST");
  assert.equal(Object.keys(policy.assets).length, 20);
  assert.equal(Object.keys(policy.packageIntegrities).length, 8);
  return {
    policy,
    exception: {
      kind: "owner-requested-test-skip" as const,
      version: policy.version,
      policySha256: digest(body),
      productSourceCommit: policy.sourceCommit,
      checks: policy.checks,
    },
  };
}
export async function verifyOwnerException(root: string) {
  const state = await policyAt(root);
  if (!state) return null;
  const { policy } = state;
  const sourceBody = await readFile(join(root, ".gitdocket-source.json"));
  assert.equal(digest(sourceBody), policy.exportSha256);
  const source = JSON.parse(sourceBody.toString());
  assert.equal(source.sourceCommit, policy.sourceCommit);
  for (const [path, hash] of Object.entries({
    ...source.files,
    ...policy.publicationOverlay,
  })) {
    assert(!path.startsWith("/") && !path.split("/").includes(".."));
    assert.equal(
      digest(await readFile(join(root, path))),
      hash,
      `source drift: ${path}`,
    );
  }
  const standalone = [];
  for (const [path, hash] of Object.entries(policy.assets)) {
    assert(/^release\/(standalone|tarballs)\/[a-zA-Z0-9.-]+$/.test(path));
    assert.equal(
      digest(await readFile(join(root, path))),
      hash,
      `artifact drift: ${path}`,
    );
    if (path.startsWith("release/standalone/"))
      standalone.push({ path, sha256: hash });
  }
  assert.equal(standalone.length, 12);
  return { ...state, standalone };
}
export async function matchesOwnerException(candidate: {
  version: string;
  testException?: OwnerTestException;
  packages: Array<{ name: string; version: string; integrity: string }>;
  standalone?: Array<{ path: string; sha256: string }>;
}) {
  if (!candidate.testException) return false;
  const state = await policyAt(join(import.meta.dir, ".."));
  if (
    !state ||
    Object.entries(state.exception).some(
      ([key, value]) =>
        (candidate.testException as unknown as Record<string, unknown>)[key] !==
        value,
    )
  )
    return false;
  if (
    candidate.version !== state.policy.version ||
    candidate.packages.length !== 8
  )
    return false;
  if (
    !candidate.packages.every(
      (item) =>
        item.version === candidate.version &&
        state.policy.packageIntegrities[item.name] === item.integrity,
    )
  )
    return false;
  const assets = candidate.standalone ?? [];
  return (
    assets.length === 12 &&
    new Set(assets.map((item) => item.path)).size === 12 &&
    assets.every((item) => state.policy.assets[item.path] === item.sha256)
  );
}
if (import.meta.main) {
  assert.equal(Bun.argv[2], "import");
  const root = join(import.meta.dir, "..");
  const state = await policyAt(root);
  assert(state, "no owner exception for this release");
  await mkdir(join(root, "release/tarballs"), { recursive: true });
  for (const path of Object.keys(state.policy.assets)) {
    if (path.startsWith("release/tarballs/"))
      await copyFile(
        join(root, "release/standalone", basename(path)),
        join(root, path),
      );
  }
  const verified = await verifyOwnerException(root);
  console.log(
    JSON.stringify(
      {
        exception: verified?.exception,
        artifacts: 20,
        productTestsExecuted: 0,
      },
      null,
      2,
    ),
  );
}
