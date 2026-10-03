import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { findRepoRoot } from "@gitdocket/core";
import type { Operation } from "@gitdocket/core/telemetry";
import { TelemetryStore } from "@gitdocket/core/telemetry";
import {
  analyzeDocketTrace,
  renderDocketTrace,
  renderUsageWindows,
  usageWindows,
} from "@gitdocket/core/telemetry-report";
import type { Command } from "commander";

async function readTraceFile(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 8 * 1024 * 1024)
      throw new Error("trace must be a regular file of at most 8 MiB");
    const buffer = Buffer.alloc(8 * 1024 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    return analyzeDocketTrace(buffer.subarray(0, length).toString("utf8"));
  } finally {
    await file.close();
  }
}

export function registerTelemetry(
  program: Command,
  write: (value: string) => Promise<void>,
) {
  const command = program
    .command("telemetry")
    .description("control opt-in local usage observations");
  const store = async () => {
    const root = await findRepoRoot(process.cwd());
    if (!root)
      throw new Error("no docket.yaml found here or in any parent directory");
    return new TelemetryStore(root);
  };
  const print = (value: unknown) => write(JSON.stringify(value, null, 2));
  command
    .command("enable")
    .description("enroll this checkout; limits apply to the shared local store")
    .option(
      "--operation-limit <n>",
      "maximum operation records (1–10000)",
      Number,
    )
    .option("--runtime-limit <n>", "maximum resource records (1–1000)", Number)
    .option("--operation-days <n>", "operation retention (1–30 days)", Number)
    .option("--runtime-days <n>", "resource retention (1–7 days)", Number)
    .option(
      "--sample-interval-ms <n>",
      "resource interval (60000–86400000 ms)",
      Number,
    )
    .option("--json", "machine-readable output")
    .action(async (options) => {
      const { json: _, ...limits } = options;
      await print((await store()).enable(limits));
    });
  for (const name of ["status", "disable"] as const)
    command
      .command(name)
      .option("--json", "machine-readable output")
      .action(async () => print((await store())[name]()));
  command
    .command("events")
    .description("inspect retained allowlisted observations")
    .option("--all", "all enrolled projects")
    .option("--json", "machine-readable output")
    .action(async (options) => print((await store()).events(options.all)));
  command
    .command("delete")
    .description(
      "remove enrollment and observations; exports remain user-owned",
    )
    .option("--all", "delete every project and rotate the shared local salt")
    .option("--json", "machine-readable output")
    .action(async (options) => {
      (await store()).delete(options.all);
      await print({
        deleted: options.all ? "all" : "current",
        exports: "user-owned",
      });
    });
  command
    .command("report")
    .description("summarize bounded observed usage and possible friction")
    .option(
      "--trace <file>",
      "locally inspect a supplied Codex read_thread JSON export (8 MiB max; not stored)",
    )
    .option(
      "--context",
      "bounded context-volume review of --trace; no telemetry-store read or host query",
    )
    .option("--since <date>", "inclusive ISO date/time")
    .option("--until <date>", "inclusive ISO date/time")
    .option("--project <id>", "one opaque project ID; default is this checkout")
    .option("--all", "all enrolled projects")
    .option(
      "--friction <operation>",
      "explicit owner flag for manual review; repeatable",
      (value: string, previous: Operation[]) => [
        ...previous,
        value as Operation,
      ],
      [] as Operation[],
    )
    .option("--json", "structured report with evidence IDs")
    .action(async (options) => {
      if (options.context) {
        if (!options.trace)
          throw new Error("--context requires --trace <supplied-file>");
        const review = (await readTraceFile(options.trace)).contextVolume;
        await write(
          options.json
            ? JSON.stringify(review, null, 2)
            : `Docket context review: ${review.coverage.matchedCalls} matched calls; export output ${review.suppliedExportOutput.bytes ?? "unavailable"} bytes; emitted response measurements ${review.emittedDocketResponses.bytes ?? "unavailable"} bytes.\nHost context: ${review.hostContext.currentOccupancyStatus}. No occupancy estimate from bytes.\nRepeated source groups: ${review.repeatedReads.length} shown (${review.omittedRepeatedGroups} omitted); ${review.compactions} recorded compactions.\n${review.repeatedReads.map((r) => `${r.calls} reads: ${r.sourceEquality}; ${r.contextAvailability}; ${r.evidence.join(", ")}`).join("\n")}\nUse --context --json for bounded contributions and observation provenance; omit --context for full trace detail.\n${review.limits.join("\n")}`,
        );
        return;
      }
      const observations = await store();
      const status = observations.status();
      if (options.all && options.project)
        throw new Error("choose --all or --project");
      const until = options.until ? Date.parse(options.until) : Date.now();
      const windows = usageWindows(
        observations.events(Boolean(options.all || options.project)),
        {
          since: options.since ? Date.parse(options.since) : undefined,
          until,
          projects: options.all
            ? undefined
            : [options.project ?? status.project ?? ""],
          limits: status.limits,
          friction: options.friction,
        },
      );
      let trace: ReturnType<typeof analyzeDocketTrace> | undefined;
      if (options.trace) {
        trace = await readTraceFile(options.trace);
      }
      await write(
        options.json
          ? JSON.stringify(
              {
                ...windows.selected,
                ...(trace ? { trace } : {}),
                traceCoverage: trace
                  ? "supplied_export_only"
                  : "not_supplied; direct agent shell reads are outside stored telemetry",
                asOf: windows.asOf,
                windows: {
                  hours24: windows.hours24,
                  days7: windows.days7,
                  fullPilot: windows.fullPilot,
                  selected: windows.selected.window,
                },
              },
              null,
              2,
            )
          : `${trace ? `${renderDocketTrace(trace)}\n\n` : "Agent trace: not supplied; direct shell reads are outside stored telemetry. Use --trace FILE for a local command review.\n\n"}${renderUsageWindows(windows)}`,
      );
    });
}
