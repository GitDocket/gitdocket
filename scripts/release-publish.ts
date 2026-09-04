import { join } from "node:path";
import { DOCKET_VERSION } from "../packages/core/src/version";

const ROOT = join(import.meta.dir, "..");
const PACKAGES = ["core", "web", "cli", "mcp"] as const;

if (process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("registry publication is restricted to GitHub Actions");
}
if (process.env.GITHUB_REPOSITORY !== "GitDocket/gitdocket") {
  throw new Error("registry publication is restricted to GitDocket/gitdocket");
}
if (
  process.env.GITHUB_REF_TYPE !== "tag" ||
  process.env.GITHUB_REF_NAME !== `v${DOCKET_VERSION}`
) {
  throw new Error(
    `registry publication requires the exact v${DOCKET_VERSION} tag`,
  );
}

for (const name of PACKAGES) {
  const tarball = join(
    ROOT,
    "release",
    "tarballs",
    `gitdocket-${name}-${DOCKET_VERSION}.tgz`,
  );
  if (!(await Bun.file(tarball).exists()))
    throw new Error(`missing ${tarball}`);
  const result = Bun.spawnSync(
    ["npm", "publish", tarball, "--access", "public"],
    {
      cwd: ROOT,
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if (result.exitCode !== 0)
    throw new Error(`publishing @gitdocket/${name} failed`);
}
