import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { InstalledSmokeOptions, SmokeResult } from "./release-stage";
import { smokeStandalone } from "./standalone-smoke";

async function command(args: string[], cwd: string, env = process.env) {
  const child = Bun.spawn(args, {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(code, 0, `${args.join(" ")}: ${stdout}\n${stderr}`);
  return stdout.trim();
}

export async function projectBytes(
  root: string,
  current = "",
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const item of await readdir(join(root, current), {
    withFileTypes: true,
  })) {
    const path = join(current, item.name);
    if (item.isDirectory())
      Object.assign(files, await projectBytes(root, path));
    else if (item.isFile())
      files[path] = createHash("sha256")
        .update(await readFile(join(root, path)))
        .digest("hex");
  }
  return files;
}

// An isolated read-only registry lets actual npm/npx resolve optional platform
// dependencies from exact local tarballs without publishing or fallback downloads.
export async function localPackageRegistry(tarballs: string[]) {
  const packages = new Map<
    string,
    { manifest: Record<string, unknown>; bytes: Uint8Array; filename: string }
  >();
  for (const path of tarballs) {
    const manifest = JSON.parse(
      await command(
        ["tar", "-xOf", resolve(path), "package/package.json"],
        tmpdir(),
      ),
    );
    packages.set(manifest.name, {
      manifest,
      bytes: await readFile(path),
      filename: basename(path),
    });
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const name = decodeURIComponent(url.pathname.slice(1));
      if (request.method !== "GET")
        return new Response("read only", { status: 405 });
      const pkg = packages.get(name);
      if (pkg) {
        const version = String(pkg.manifest.version);
        return Response.json({
          name,
          "dist-tags": { latest: version },
          versions: {
            [version]: {
              ...pkg.manifest,
              dist: {
                tarball: `${url.origin}/tarballs/${pkg.filename}`,
                integrity: `sha512-${createHash("sha512").update(pkg.bytes).digest("base64")}`,
                shasum: createHash("sha1").update(pkg.bytes).digest("hex"),
              },
            },
          },
        });
      }
      for (const item of packages.values())
        if (name === `tarballs/${item.filename}`)
          return new Response(new Uint8Array(item.bytes).buffer);
      return Response.json(
        { error: "Package is outside this candidate" },
        { status: 404 },
      );
    },
  });
  return { url: server.url.toString(), stop: () => server.stop(true) };
}

export async function runNpmInstalledSmoke(
  options: InstalledSmokeOptions,
): Promise<SmokeResult> {
  const root = await mkdtemp(join(tmpdir(), "gitdocket-npm-smoke-"));
  let registry: Awaited<ReturnType<typeof localPackageRegistry>> | undefined;
  try {
    if (options.localTarballs)
      registry = await localPackageRegistry(
        Object.values(options.dependencies).map((value) =>
          value.replace(/^file:/, ""),
        ),
      );
    const npm = Bun.which("npm");
    const node = Bun.which("node");
    const git = Bun.which("git");
    assert(npm && node && git);
    const runtime = join(root, "runtime");
    await mkdir(runtime);
    for (const [name, path] of [
      ["node", node],
      ["git", git],
      ["npm", npm],
      ["sh", "/bin/sh"],
    ] as const)
      await symlink(path, join(runtime, name));
    const env = {
      ...process.env,
      PATH: runtime,
      npm_config_cache: join(root, "cache"),
      npm_config_registry: registry?.url ?? "https://registry.npmjs.org/",
      npm_config_userconfig: join(root, "empty.npmrc"),
      npm_config_globalconfig: join(root, "empty-global.npmrc"),
    };
    await writeFile(env.npm_config_userconfig, "");
    await writeFile(env.npm_config_globalconfig, "");
    assert.equal(Bun.which("bun", { PATH: env.PATH }), null);
    const prefix = join(root, "global");
    const packages = [
      `@gitdocket/cli@${options.version}`,
      `@gitdocket/mcp@${options.version}`,
    ];
    await command(
      [
        npm,
        "install",
        "--global",
        "--prefix",
        prefix,
        "--ignore-scripts",
        "--include=optional",
        "--no-audit",
        "--no-fund",
        ...packages,
      ],
      root,
      env,
    );
    const bin = join(prefix, "bin");
    let mcpTools: string[] = [];
    await smokeStandalone(bin, {
      node: true,
      onTools: (names) => {
        mcpTools = names;
      },
    });
    const packageVersions: Record<string, string> = {};
    for (const name of ["@gitdocket/cli", "@gitdocket/mcp"]) {
      const path = join(prefix, "lib/node_modules", name, "package.json");
      const manifest = JSON.parse(await readFile(path, "utf8"));
      assert.equal(manifest.version, options.version);
      assert(!manifest.engines.bun);
      for (const value of Object.values(manifest.optionalDependencies))
        assert.equal(value, options.version);
      packageVersions[name] = manifest.version;
    }
    // Exercise the documented npm exec/npx form with a separate cache and prefix.
    const project = join(root, "npx-project");
    await mkdir(project);
    const npxEnv = {
      ...env,
      npm_config_cache: join(root, "npx-cache"),
      npm_config_prefix: join(root, "npx-prefix"),
    };
    const npx = [
      npm,
      "exec",
      "--yes",
      "--ignore-scripts",
      "--include=optional",
      ...packages.map((pkg) => `--package=${pkg}`),
      "--",
    ];
    assert.equal(
      await command([...npx, "docket", "--version"], project, npxEnv),
      options.version,
    );
    await command(
      [...npx, "docket", "init", "--project", "NPX", "--json"],
      project,
      npxEnv,
    );
    const resolvedNpx = await command(
      [
        ...npx,
        "node",
        "-e",
        'const fs=require("node:fs"),p=require("node:path");const bin=process.env.PATH.split(p.delimiter).find(d=>fs.existsSync(p.join(d,"docket")));if(!bin)process.exit(1);console.log(p.join(bin,"docket"));',
      ],
      project,
      npxEnv,
    );
    await smokeStandalone(dirname(resolvedNpx), { node: true });
    const nativeName = `@gitdocket/bin-${process.platform}-${process.arch}`;
    const nativePath = await command(
      [
        node,
        "-e",
        `console.log(require.resolve(${JSON.stringify(`${nativeName}/package.json`)}, { paths: [${JSON.stringify(join(prefix, "lib/node_modules/@gitdocket/cli"))}] }))`,
      ],
      root,
      env,
    );
    const nativeManifest = JSON.parse(await readFile(nativePath, "utf8"));
    assert.equal(nativeManifest.version, options.version);
    packageVersions[nativeName] = nativeManifest.version;
    await writeFile(
      join(project, "authored-note.md"),
      "Keep the owner's project notes and instructions.\n",
    );
    const before = await projectBytes(project);
    await command(
      [
        npm,
        "update",
        "--global",
        "--prefix",
        prefix,
        "--ignore-scripts",
        "--include=optional",
        "--no-audit",
        "--no-fund",
        "@gitdocket/cli",
        "@gitdocket/mcp",
      ],
      root,
      env,
    );
    assert.equal(
      await command([join(bin, "docket"), "--version"], project, env),
      options.version,
    );
    await command(
      [
        npm,
        "uninstall",
        "--global",
        "--prefix",
        prefix,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "@gitdocket/cli",
        "@gitdocket/mcp",
      ],
      root,
      env,
    );
    assert.deepEqual(await projectBytes(project), before);
    assert(!(await Bun.file(join(bin, "docket")).exists()));
    assert(!(await Bun.file(join(bin, "docket-mcp")).exists()));
    // Exercise migration from the last published Bun-dependent command packages.
    const prior = join(root, "prior-global");
    await command(
      [
        npm,
        "install",
        "--global",
        "--prefix",
        prior,
        "--registry",
        "https://registry.npmjs.org/",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "@gitdocket/cli@0.3.1",
        "@gitdocket/mcp@0.3.1",
      ],
      root,
      env,
    );
    assert(
      (await readFile(join(prior, "bin/docket"), "utf8")).startsWith(
        "#!/usr/bin/env bun",
      ),
    );
    await command(
      [
        npm,
        "update",
        "--global",
        "--prefix",
        prior,
        "--ignore-scripts",
        "--include=optional",
        "--no-audit",
        "--no-fund",
        "@gitdocket/cli",
        "@gitdocket/mcp",
      ],
      root,
      env,
    );
    await smokeStandalone(join(prior, "bin"), { node: true });
    assert.deepEqual(await projectBytes(project), before);
    return { packageVersions, mcpTools, serveStatus: 200 };
  } finally {
    registry?.stop();
    await rm(root, { recursive: true, force: true });
  }
}
