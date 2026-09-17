#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const { accessSync, constants } = require("node:fs");
const { dirname, join } = require("node:path");

const targets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];

function targetFor(platform, arch) {
  const target = `${platform}-${arch}`;
  if (!targets.includes(target)) {
    throw new Error(
      `Unsupported platform ${target}. GitDocket supports macOS and glibc Linux on arm64 and x64.`,
    );
  }
  return target;
}

function launch() {
  const manifest = require("../package.json");
  const command = manifest.name === "@gitdocket/mcp" ? "docket-mcp" : "docket";
  let binary;
  try {
    const target = targetFor(process.platform, process.arch);
    if (
      process.platform === "linux" &&
      !process.report.getReport().header.glibcVersionRuntime
    ) {
      throw new Error(
        "This Linux release requires glibc; musl/Alpine is unsupported.",
      );
    }
    const packageName = `@gitdocket/bin-${target}`;
    const packagePath = require.resolve(`${packageName}/package.json`);
    const platform = require(packagePath);
    if (
      platform.version !== manifest.version ||
      !manifest.gitdocketSource ||
      JSON.stringify(platform.gitdocketSource) !==
        JSON.stringify(manifest.gitdocketSource)
    ) {
      throw new Error(
        `The ${packageName} binary does not match ${manifest.name}@${manifest.version}.`,
      );
    }
    binary = join(dirname(packagePath), "bin", command);
    accessSync(binary, constants.X_OK);
  } catch (error) {
    process.stderr.write(
      `${command}: ${error.message}\nReinstall with optional dependencies enabled: npm install -g --include=optional @gitdocket/cli@${manifest.version} @gitdocket/mcp@${manifest.version}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });
  const signals = ["SIGHUP", "SIGINT", "SIGTERM"];
  const handlers = new Map(
    signals.map((signal) => [signal, () => child.kill(signal)]),
  );
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const cleanup = () => {
    for (const [signal, handler] of handlers)
      process.removeListener(signal, handler);
  };
  child.once("error", (error) => {
    cleanup();
    process.stderr.write(
      `${command}: cannot start ${binary}: ${error.message}\n`,
    );
    process.exitCode = 1;
  });
  child.once("close", (code, signal) => {
    cleanup();
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}

module.exports = { targetFor, launch };
if (require.main === module) launch();
