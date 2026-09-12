import { expect, test } from "bun:test";
import { createJsonRequests } from "./requests";

test("concurrent readers share one fetch, cancellation is leased, and settled reads never mask external changes", async () => {
  let resolve: (response: Response) => void = () => {};
  let calls = 0;
  let signal: AbortSignal | null | undefined;
  const fetcher = (_url: unknown, options: RequestInit) => {
    calls++;
    signal = options.signal;
    return new Promise<Response>((r) => {
      resolve = r;
    });
  };
  const cache = createJsonRequests(fetcher);
  const first = cache.acquire("/api/tasks", "1");
  const second = cache.acquire("/api/tasks", "1");
  expect(calls).toBe(1);
  first.release();
  expect(signal?.aborted).toBe(false);
  resolve(
    new Response('{"id":1}', { headers: { "X-Docket-Freshness": "stale" } }),
  );
  expect((await second.result).stale).toBe(true);
  second.release();
  const next = cache.acquire("/api/tasks", "1");
  expect(calls).toBe(2);
  next.release();
  expect(signal?.aborted).toBe(true);
  resolve(new Response("{}"));
  await next.result;
});
test("a forced mutation reload cannot join a pending pre-write read", async () => {
  const resolves: ((response: Response) => void)[] = [];
  const cache = createJsonRequests(
    () => new Promise<Response>((r) => resolves.push(r)),
  );
  const old = cache.acquire<{ v: number }>("/api/tasks", "1");
  const fresh = cache.acquire<{ v: number }>("/api/tasks", "1", true);
  expect(resolves.length).toBe(2);
  resolves[1]?.(new Response('{"v":2}'));
  expect((await fresh.result).data.v).toBe(2);
  resolves[0]?.(new Response('{"v":1}'));
  expect((await old.result).data.v).toBe(1);
  old.release();
  fresh.release();
});
