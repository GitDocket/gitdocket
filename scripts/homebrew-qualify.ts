import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DOCKET_VERSION } from "../packages/core/src/version";
import { prepareTap } from "./homebrew-tap";
import { qualificationHost } from "./macos-qualification";
import { projectBytes } from "./npm-smoke";
import { digest } from "./standalone-release";
import type { CheckLevel } from "./standalone-smoke";
import { smokeStandalone } from "./standalone-smoke";

// Run only in a disposable Homebrew prefix or on an ephemeral CI runner.
export async function qualifyHomebrew(options: {
  source: string;
  artifacts: string;
  brew: string;
  audit?: boolean;
  level?: CheckLevel;
}) {
  const level = options.level ?? "deep";
  assert(["basic", "deep"].includes(level), "invalid Homebrew check level");
  const root = await mkdtemp(join(tmpdir(), "gitdocket-homebrew-"));
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOMEBREW_NO_AUTO_UPDATE: "1",
    HOMEBREW_NO_ANALYTICS: "1",
    HOMEBREW_NO_INSTALL_CLEANUP: "1",
  };
  const commands: string[][] = [];
  async function run(
    args: string[],
    cwd = root,
    variables = env,
    expected = 0,
  ) {
    commands.push(args);
    const child = Bun.spawn(args, {
      cwd,
      env: variables,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 300_000,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const message = `${args.join(" ")}\n${stdout}\n${stderr}`;
    if (expected === 0) assert.equal(code, 0, message);
    else assert.notEqual(code, 0, message);
    process.stderr.write(`✓ ${args.join(" ")} (${code})\n`);
    return { stdout: stdout.trim(), stderr: stderr.trim(), code };
  }
  const brew = (...args: string[]) => run([options.brew, ...args]);
  const prefix = (await brew("--prefix")).stdout;
  assert(
    !(await Bun.file(join(prefix, "bin/docket")).exists()),
    "refusing an existing docket command in the Homebrew prefix",
  );
  assert(
    !(await Bun.file(join(prefix, "bin/docket-mcp")).exists()),
    "refusing an existing docket-mcp command in the Homebrew prefix",
  );
  assert(
    !(await brew("list", "--formula", "--versions")).stdout
      .split("\n")
      .some((line) => line.startsWith("gitdocket ")),
    "refusing an existing gitdocket keg",
  );
  const expectedPrefix =
    process.platform === "linux"
      ? "/home/linuxbrew/.linuxbrew"
      : process.arch === "arm64"
        ? "/opt/homebrew"
        : "/usr/local";
  if (process.env.GITHUB_ACTIONS)
    assert.equal(
      prefix,
      expectedPrefix,
      "CI must qualify the standard Homebrew prefix",
    );
  const tapName = "gitdocket/qualification";
  const formulaName = `${tapName}/gitdocket`;
  let tapped = false;
  let installed = false;
  try {
    const tap = join(root, "tap");
    const prepared = await prepareTap({
      source: options.source,
      artifacts: options.artifacts,
      output: tap,
    });
    const original = await readFile(join(tap, "Formula/gitdocket.rb"), "utf8");
    await run(["git", "init", "-q", tap]);
    await run(["git", "add", "."], tap);
    await run(
      [
        "git",
        "-c",
        "user.name=GitDocket qualification",
        "-c",
        "user.email=qualification@example.invalid",
        "commit",
        "-qm",
        "Prepare isolated candidate formula",
      ],
      tap,
    );
    await brew("trust", "--formula", formulaName);
    await brew("tap", tapName, tap);
    tapped = true;
    const formula = join(
      (await brew("--repository", tapName)).stdout,
      "Formula/gitdocket.rb",
    );
    if (options.audit) {
      await brew("audit", "--strict", "--os=all", "--arch=all", formulaName);
      await brew("style", formulaName);
    }
    // Transport-only mirror: retain exact archive bytes/checksums. A file URL
    // lacks GitHub tag version detection, so explicitly declare its version.
    const mirrored = original
      .replace(
        /https:\/\/github.com\/GitDocket\/gitdocket\/releases\/download\/v[^/]+\//g,
        `${pathToFileURL(resolve(options.artifacts)).href}/`,
      )
      .replace(
        '  license "Apache-2.0"',
        `  license "Apache-2.0"\n  version "${DOCKET_VERSION}"`,
      );
    const writeFormula = (revision: number, text = mirrored) =>
      writeFile(
        formula,
        text.replace(
          '  license "Apache-2.0"',
          `  license "Apache-2.0"\n  revision ${revision}`,
        ),
      );
    await writeFormula(0);
    await brew("install", formulaName);
    installed = true;
    await brew("test", formulaName);
    const bin = join(prefix, "bin");
    const installedEnv = { ...env, PATH: `${bin}:${env.PATH}` };
    const stableMcp = join(prefix, "opt/gitdocket/bin/docket-mcp");
    const manifest = JSON.parse(
      await readFile(
        join(options.artifacts, `${process.platform}-${process.arch}.json`),
        "utf8",
      ),
    );
    for (const name of ["docket", "docket-mcp"])
      assert.equal(
        digest(await readFile(join(bin, name))),
        manifest.files[name],
      );
    const smoke = await smokeStandalone(bin, { level });
    if (level === "basic")
      return {
        schema: 1,
        status: "READY",
        level,
        version: DOCKET_VERSION,
        target: `${process.platform}-${process.arch}`,
        source: prepared.source,
        homebrew: (await brew("--version")).stdout,
        prefix,
        standardPrefix: prefix === expectedPrefix,
        host: (await run(["uname", "-a"])).stdout,
        qualificationHost: qualificationHost(),
        formulaSha256: prepared.formulaSha256,
        archiveSha256: manifest.sha256,
        smoke,
        checks: [
          "formula install and both executable hashes",
          "formula functional test",
        ],
        assistance:
          "Isolated prefix and exact local archive mirror; installed product has no Bun, Node or npm on PATH.",
        commands,
      };
    const project = join(root, "adopter");
    await mkdir(project);
    await run(["git", "init", "-q"], project);
    await run(
      [
        join(bin, "docket"),
        "init",
        "--project",
        "BREW",
        "--agent",
        "claude",
        "--agent",
        "codex",
        "--agent",
        "cursor",
        "--json",
      ],
      project,
      installedEnv,
    );
    await writeFile(
      join(project, "authored.md"),
      "Preserve these project requirements.\n",
    );
    // A real published npm installation remains on disk during the channel switch.
    const npm = Bun.which("npm");
    assert(npm, "npm is needed only by the migration verification harness");
    const prior = join(root, "prior-npm");
    await run([
      npm,
      "install",
      "--global",
      "--prefix",
      prior,
      "--registry=https://registry.npmjs.org",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "@gitdocket/cli@0.3.1",
      "@gitdocket/mcp@0.3.1",
    ]);
    const oldBin = join(prior, "bin");
    const oldMcp = join(oldBin, "docket-mcp");
    assert((await readFile(oldMcp, "utf8")).startsWith("#!/usr/bin/env bun"));
    const oldFiles = await projectBytes(prior);
    const config = join(project, ".mcp.json");
    const configBody = JSON.parse(await readFile(config, "utf8"));
    configBody.mcpServers.docket.command = oldMcp;
    await writeFile(config, `${JSON.stringify(configBody, null, 2)}\n`);
    const before = await projectBytes(project);
    for (const name of ["docket", "docket-mcp"]) {
      assert.equal(
        Bun.which(name, { PATH: `${oldBin}:${bin}` }),
        join(oldBin, name),
      );
      assert.equal(
        Bun.which(name, { PATH: `${bin}:${oldBin}` }),
        join(bin, name),
      );
    }
    await brew("reinstall", formulaName);
    await writeFormula(1);
    await brew("upgrade", formulaName);
    assert(
      (await brew("list", "--versions", formulaName)).stdout.includes(
        `${DOCKET_VERSION}_1`,
      ),
    );
    const acceptedPath = await realpath(join(bin, "docket"));
    // A bad candidate must fail before replacing the working commands.
    await writeFormula(
      2,
      mirrored.replace(/sha256 "[a-f0-9]{64}"/g, `sha256 "${"0".repeat(64)}"`),
    );
    const checksum = await run(
      [options.brew, "upgrade", formulaName],
      root,
      env,
      1,
    );
    assert(
      /SHA-?256 mismatch|checksum mismatch|reports different checksum/i.test(
        checksum.stderr,
      ),
      checksum.stderr,
    );
    assert.equal(await realpath(join(bin, "docket")), acceptedPath);
    await writeFormula(
      2,
      mirrored.replace(
        /file:[^"]+\.tar\.gz/g,
        `${pathToFileURL(join(root, "missing-archive.tar.gz")).href}`,
      ),
    );
    const download = await run(
      [options.brew, "upgrade", formulaName],
      root,
      env,
      1,
    );
    assert(/download|file|fetch/i.test(download.stderr));
    assert.equal(await realpath(join(bin, "docket")), acceptedPath);
    await writeFormula(1);
    await brew("test", formulaName);
    assert.deepEqual(await projectBytes(project), before);
    // Existing custom MCP paths are preserved by init; migration is deliberate.
    await run(
      [join(bin, "docket"), "init", "--agent", "claude", "--json"],
      project,
      installedEnv,
    );
    assert.equal(
      JSON.parse(await readFile(config, "utf8")).mcpServers.docket.command,
      oldMcp,
    );
    configBody.mcpServers.docket.command = stableMcp;
    await writeFile(config, `${JSON.stringify(configBody, null, 2)}\n`);
    const productPath = join(root, "product-path");
    await mkdir(productPath);
    const git = Bun.which("git");
    assert(git);
    await symlink(git, join(productPath, "git"));
    for (const runtime of ["bun", "node", "npm", "npx"])
      assert.equal(Bun.which(runtime, { PATH: productPath }), null);
    const client = new Client({ name: "homebrew-migration", version: "1" });
    try {
      await client.connect(
        new StdioClientTransport({
          command: stableMcp,
          cwd: project,
          env: { PATH: productPath },
          stderr: "pipe",
        }),
      );
      assert(
        !(await client.callTool({ name: "ready", arguments: {} })).isError,
      );
    } finally {
      await client.close();
    }
    for (const name of ["docket", "docket-mcp"])
      assert.equal(
        (
          await run([join(bin, name), "--version"], project, {
            ...env,
            PATH: productPath,
          })
        ).stdout,
        DOCKET_VERSION,
      );
    const migrated = await projectBytes(project);
    await brew("uninstall", formulaName);
    installed = false;
    for (const name of ["docket", "docket-mcp"])
      assert(!(await Bun.file(join(bin, name)).exists()));
    assert.deepEqual(await projectBytes(project), migrated);
    assert.deepEqual(await projectBytes(prior), oldFiles);
    return {
      schema: 1,
      status: "READY",
      level,
      version: DOCKET_VERSION,
      target: `${process.platform}-${process.arch}`,
      source: prepared.source,
      homebrew: (await brew("--version")).stdout,
      prefix,
      standardPrefix:
        prefix ===
        (process.platform === "linux"
          ? "/home/linuxbrew/.linuxbrew"
          : process.arch === "arm64"
            ? "/opt/homebrew"
            : "/usr/local"),
      host: (await run(["uname", "-a"])).stdout,
      qualificationHost: qualificationHost(),
      formulaSha256: prepared.formulaSha256,
      archiveSha256: manifest.sha256,
      smoke,
      checks: [
        "formula install and both executable hashes",
        "formula functional test",
        "reinstall",
        "revision upgrade",
        "failed checksum preserves accepted keg",
        "failed download preserves accepted keg",
        "published npm 0.3.1 precedence",
        "preserved custom MCP path and explicit migration",
        "MCP actual tool through stable Homebrew opt path",
        "uninstall preserves project and competing npm installation",
      ],
      assistance:
        "Ephemeral runner or isolated prefix; local file mirror of exact qualified archives. Bun/npm are harness tools only; product smoke PATH contains Git and copied binaries, with no source ancestor. Earlier formula is revision 0 of this candidate because no prior formula release exists.",
      failureDiagnostics: {
        checksum: checksum.stderr,
        download: download.stderr,
      },
      commands,
    };
  } finally {
    if (tapped) {
      // Normal uninstall revokes formula trust and can retain an older keg
      // when cleanup was disabled. Remove only this harness's retained kegs.
      await brew("trust", "--formula", formulaName);
      if (installed || existsSync(join(prefix, "Cellar/gitdocket")))
        await brew("uninstall", "--force", formulaName);
      await brew("untap", tapName);
    }
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      source: { type: "string" },
      artifacts: { type: "string" },
      brew: { type: "string" },
      output: { type: "string" },
      audit: { type: "boolean" },
      level: { type: "string" },
    },
  });
  const source = resolve(values.source ?? join(import.meta.dir, ".."));
  const brew = values.brew ?? Bun.which("brew");
  assert(brew);
  const result = await qualifyHomebrew({
    source,
    artifacts: resolve(values.artifacts ?? join(source, "release/standalone")),
    brew,
    audit: values.audit,
    level: (values.level ?? "deep") as CheckLevel,
  });
  const body = `${JSON.stringify(result, null, 2)}\n`;
  if (values.output) await writeFile(values.output, body);
  console.log(body);
}
