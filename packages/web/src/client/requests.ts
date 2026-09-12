// Shared reads are keyed by revision and URL. Only in-flight work is shared:
// route reuse cannot silently bypass the server's current freshness barrier.
interface Result<T> {
  data: T;
  stale: boolean;
}
interface Pending {
  controller: AbortController;
  readers: number;
  settled: boolean;
  promise: Promise<Result<unknown>>;
}
export function createJsonRequests(
  fetcher: (url: string, options: RequestInit) => Promise<Response> = (
    url,
    options,
  ) => fetch(url, options),
) {
  const pending = new Map<string, Pending>();
  return {
    acquire<T>(
      url: string,
      revision: string,
      fresh = false,
      trigger: "explicit" | "background" | "unknown" = "unknown",
    ) {
      const key = `${revision}:${url}`;
      let request = fresh ? undefined : pending.get(key);
      if (!request) {
        const controller = new AbortController();
        request = {
          controller,
          readers: 0,
          settled: false,
          promise: Promise.resolve({ data: undefined, stale: false }),
        };
        const owner = request;
        owner.promise = (async () => {
          const response = await fetcher(url, {
            signal: controller.signal,
            headers: { "X-Docket-Trigger": trigger },
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error ?? response.statusText);
          return {
            data,
            stale: response.headers.get("X-Docket-Freshness") === "stale",
          };
        })().finally(() => {
          owner.settled = true;
          if (pending.get(key) === owner) pending.delete(key);
        });
        if (!fresh) pending.set(key, owner);
      }
      const owner = request;
      owner.readers++;
      let released = false;
      return {
        result: owner.promise as Promise<Result<T>>,
        release() {
          if (released) return;
          released = true;
          owner.readers--;
          if (!owner.readers && !owner.settled) {
            owner.controller.abort();
            if (pending.get(key) === owner) pending.delete(key);
          }
        },
      };
    },
  };
}
