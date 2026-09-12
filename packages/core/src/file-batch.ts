import { setImmediate } from "node:timers/promises";

/** Bounded I/O, stable path/error order, and a yield between parsing batches. */
export async function mapFiles<T>(
  paths: readonly string[],
  read: (path: string) => Promise<T>,
  signal?: AbortSignal,
): Promise<T[]> {
  const results: T[] = [];
  for (let start = 0; start < paths.length; start += 16) {
    signal?.throwIfAborted();
    const batch = await Promise.allSettled(
      paths.slice(start, start + 16).map(read),
    );
    signal?.throwIfAborted();
    for (const item of batch) {
      if (item.status === "rejected") throw item.reason;
      results.push(item.value);
    }
    await setImmediate();
  }
  return results;
}
