import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type Observation = {
  state: "READY" | "PENDING" | "CONFLICT";
  detail: unknown;
};
export const exitFor = { READY: 0, CONFLICT: 1, PENDING: 2 } as const;

export async function saveReceipt(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  const temporary = `${resolve(path)}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, resolve(path));
}

export async function waitUntil(options: {
  predicate: unknown;
  observe: () => Promise<Observation>;
  output?: string;
  resume: string[];
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
  progress?: (message: string) => void;
}): Promise<Observation> {
  const now = options.now ?? (() => performance.now());
  const timeout = options.timeoutMs ?? 600_000;
  const interval = options.intervalMs ?? 10_000;
  if (
    !Number.isFinite(timeout) ||
    timeout < 0 ||
    !Number.isFinite(interval) ||
    interval <= 0
  ) {
    throw new Error(
      "wait requires finite nonnegative timeout and positive interval",
    );
  }
  const deadline = now() + timeout;
  let observation: Observation = {
    state: "PENDING",
    detail: "not yet observed",
  };
  const persist = async () => {
    if (!options.output) return;
    await saveReceipt(options.output, {
      schema: 1,
      predicate: options.predicate,
      resume: options.resume,
      observedAt: new Date().toISOString(),
      ...observation,
      externalWrites: false,
      exitCode: exitFor[observation.state],
    });
  };
  await persist();
  for (;;) {
    try {
      observation = await options.observe();
    } catch (error) {
      observation = {
        state: "PENDING",
        detail: {
          observationError:
            error instanceof Error ? error.message : String(error),
        },
      };
    }
    await persist();
    options.progress?.(`[release-wait] ${observation.state} ${options.output}`);
    if (observation.state !== "PENDING" || now() >= deadline)
      return observation;
    await (options.sleep ?? Bun.sleep)(Math.min(interval, deadline - now()));
  }
}
