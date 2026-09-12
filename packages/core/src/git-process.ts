/** Bounded asynchronous local Git reads. One owner controls cancellation. */
export class GitProcessPool {
  private active = 0;
  private waiting: (() => void)[] = [];
  private controller = new AbortController();

  constructor(
    private readonly options: {
      concurrency?: number;
      timeoutMs?: number;
      maxBytes?: number;
      onCommand?: (args: string[]) => void;
    } = {},
  ) {}

  close(): void {
    this.controller.abort();
    for (const wake of this.waiting.splice(0)) wake();
  }

  async run(
    cwd: string,
    args: string[],
    deadline = Number.POSITIVE_INFINITY,
  ): Promise<string> {
    const signal = this.controller.signal;
    while (this.active >= (this.options.concurrency ?? 4)) {
      signal.throwIfAborted();
      await new Promise<void>((wake) => this.waiting.push(wake));
    }
    signal.throwIfAborted();
    if (Date.now() >= deadline)
      throw new Error("Git observation deadline exceeded");
    this.active++;
    try {
      this.options.onCommand?.(args);
      const detached = process.platform !== "win32";
      const proc = Bun.spawn(["git", "-c", "core.fsmonitor=false", ...args], {
        cwd,
        detached,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
          GIT_PAGER: "cat",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      let failure: Error | undefined;
      const stop = (reason: string) => {
        failure ??= new Error(reason);
        try {
          if (detached) process.kill(-proc.pid, "SIGKILL");
          else proc.kill("SIGKILL");
        } catch {
          proc.kill("SIGKILL");
        }
      };
      const abort = () => stop("Git read cancelled");
      signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(
        () => stop("Git read timed out"),
        Math.min(this.options.timeoutMs ?? 15000, deadline - Date.now()),
      );
      let bytes = 0;
      const read = async (stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        const chunks: string[] = [];
        try {
          for (;;) {
            const result = await reader.read();
            if (result.done) break;
            bytes += result.value.byteLength;
            if (bytes > (this.options.maxBytes ?? 64 * 1024 * 1024))
              stop("Git output exceeded its byte budget");
            if (!failure)
              chunks.push(decoder.decode(result.value, { stream: true }));
          }
          if (!failure) chunks.push(decoder.decode());
          return chunks.join("");
        } finally {
          reader.releaseLock();
        }
      };
      try {
        const results = await Promise.allSettled([
          read(proc.stdout),
          read(proc.stderr),
          proc.exited,
        ]);
        if (failure) throw failure;
        const [out, err, exit] = results;
        for (const result of results)
          if (result.status === "rejected") throw result.reason;
        if (
          out.status !== "fulfilled" ||
          err.status !== "fulfilled" ||
          exit.status !== "fulfilled"
        )
          throw new Error("Git read failed");
        if (exit.value !== 0)
          throw new Error(
            `Git ${args[0]} failed: ${err.value.trim().slice(0, 1024)}`,
          );
        return out.value;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      }
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}
