import { findRepoRoot } from "@gitdocket/core";
import type { Operation } from "@gitdocket/core/telemetry";
import { TelemetryStore } from "@gitdocket/core/telemetry";
import {
  renderUsageWindows,
  usageWindows,
} from "@gitdocket/core/telemetry-report";
import type { Command } from "commander";

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
      await write(
        options.json
          ? JSON.stringify(
              {
                ...windows.selected,
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
          : renderUsageWindows(windows),
      );
    });
}
