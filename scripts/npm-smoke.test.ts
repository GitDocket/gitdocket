import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { smokeRegistryConfig } from "./npm-smoke";

test("real npm update follows staged while outgoing latest remains older", async () => {
  const root = await mkdtemp(join(tmpdir(), "staged-update-test-"));
  const tarballs = new Map<string, Uint8Array>();
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    for (const version of ["1.0.0", "1.0.1"]) {
      const dir = join(root, version);
      await mkdir(join(dir, "package"), { recursive: true });
      await writeFile(
        join(dir, "package/package.json"),
        JSON.stringify({ name: "@gitdocket/cli", version }),
      );
      const result = Bun.spawnSync([
        "tar",
        "-czf",
        join(dir, "package.tgz"),
        "-C",
        dir,
        "package",
      ]);
      expect(result.exitCode).toBe(0);
      tarballs.set(
        version,
        new Uint8Array(await Bun.file(join(dir, "package.tgz")).arrayBuffer()),
      );
    }
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        const version = url.pathname.match(/^\/tarball\/(1\.0\.[01])$/)?.[1];
        if (version)
          return new Response(
            new Uint8Array(tarballs.get(version) ?? []).buffer,
          );
        if (decodeURIComponent(url.pathname) !== "/@gitdocket/cli")
          return new Response("not found", { status: 404 });
        return Response.json({
          name: "@gitdocket/cli",
          "dist-tags": { latest: "1.0.0", staged: "1.0.1" },
          versions: Object.fromEntries(
            [...tarballs].map(([v, bytes]) => [
              v,
              {
                name: "@gitdocket/cli",
                version: v,
                dist: {
                  tarball: `${url.origin}/tarball/${v}`,
                  integrity: `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`,
                },
              },
            ]),
          ),
        });
      },
    });
    const env = {
      ...process.env,
      ...smokeRegistryConfig({
        version: "1.0.1",
        dependencies: {},
        registryTag: "staged",
      }),
      npm_config_registry: server.url.href,
      "npm_config_@gitdocket:registry": server.url.href,
      npm_config_cache: join(root, "cache"),
      npm_config_userconfig: join(root, "empty.npmrc"),
      npm_config_globalconfig: join(root, "global.npmrc"),
    };
    await writeFile(env.npm_config_userconfig, "");
    await writeFile(env.npm_config_globalconfig, "");
    const run = async (args: string[]) => {
      const child = Bun.spawn(
        [
          "npm",
          ...args,
          "--prefix",
          join(root, "prefix"),
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
        ],
        { env, cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      const [code, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
      ]);
      expect(stderr).not.toContain("ERR!");
      expect(code).toBe(0);
    };
    await run(["install", "--global", "@gitdocket/cli@1.0.0"]);
    await run(["update", "--global", "@gitdocket/cli"]);
    expect(
      (
        await Bun.file(
          join(root, "prefix/lib/node_modules/@gitdocket/cli/package.json"),
        ).json()
      ).version,
    ).toBe("1.0.1");
  } finally {
    server?.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
