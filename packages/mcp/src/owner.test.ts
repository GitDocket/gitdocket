import { expect, test } from "bun:test";
import { InMemoryFileStore, parseConfig } from "@gitdocket/core";
import { RepositoryOwner } from "./owner";

const text = (id: string, status = "todo") =>
  `---\ntype: Task\nid: ${id}\nstatus: ${status}\n---\n`;
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

test("a read enqueued with a mutation waits for the current write barrier", async () => {
  for (const method of ["metadata", "read"] as const) {
    const store = new InMemoryFileStore(new Map([["a.md", text("DKT-1")]]));
    const owner = new RepositoryOwner(async () => ({
      store,
      config: parseConfig(),
    }));
    const resume = gate();
    const initial = owner[method]();
    const write = owner.mutate(async ({ store }) => {
      await resume.promise;
      await store.write("a.md", text("DKT-1", "done"));
    });
    let completed = false;
    const after = owner[method]().then((result) => {
      completed = true;
      return result;
    });
    await Bun.sleep(10);
    expect(completed).toBe(false);
    resume.release();
    await write;
    const result = await after;
    const bundle =
      "snapshot" in result ? result.snapshot.bundle : result.bundle;
    expect(bundle.byId("DKT-1")?.fm.status).toBe("done");
    await initial;
    owner.close();
  }
});

test("closing a metadata owner drains the first batch and cancels remaining reads", async () => {
  const store = new InMemoryFileStore(
    new Map(
      Array.from({ length: 80 }, (_, i) => [`${i}.md`, text(`DKT-${i}`)]),
    ),
  );
  const entered = gate();
  const resume = gate();
  const read = store.read.bind(store);
  let reads = 0;
  store.read = async (path) => {
    reads++;
    entered.release();
    await resume.promise;
    return read(path);
  };
  const owner = new RepositoryOwner(async () => ({
    store,
    config: parseConfig(),
  }));
  const pending = owner.metadata();
  await entered.promise;
  owner.close();
  resume.release();
  await expect(pending).rejects.toThrow();
  expect(reads).toBe(16);
});

test("owner coalesces reads, rechecks external writes/deletes, and recovers from failures", async () => {
  const store = new InMemoryFileStore(new Map([["a.md", text("DKT-1")]]));
  let reads = 0;
  let fail = false;
  const read = store.read.bind(store);
  store.read = async (path) => {
    reads++;
    if (fail) throw new Error("unavailable");
    return read(path);
  };
  const owner = new RepositoryOwner(async () => ({
    store,
    config: parseConfig(),
  }));
  try {
    const results = await Promise.all(
      Array.from({ length: 4 }, () => owner.read()),
    );
    expect(reads).toBe(1);
    expect(
      results.every((result) => result.snapshot === results[0]?.snapshot),
    ).toBe(true);
    await store.write("a.md", text("DKT-1", "done"));
    expect((await owner.read()).snapshot.bundle.byId("DKT-1")?.fm.status).toBe(
      "done",
    );
    fail = true;
    await expect(owner.read()).rejects.toThrow("unavailable");
    fail = false;
    store.files.delete("a.md");
    expect((await owner.read()).snapshot.bundle.byId("DKT-1")).toBeUndefined();
  } finally {
    owner.close();
  }
});

test("late refresh cannot publish across a queued write, including partial failure", async () => {
  const store = new InMemoryFileStore(new Map([["a.md", text("DKT-1")]]));
  const entered = gate();
  const resume = gate();
  const read = store.read.bind(store);
  let first = true;
  store.read = async (path) => {
    const source = await read(path);
    if (first) {
      first = false;
      entered.release();
      await resume.promise;
    }
    return source;
  };
  const owner = new RepositoryOwner(async () => ({
    store,
    config: parseConfig(),
  }));
  try {
    const pending = owner.read();
    await entered.promise;
    await expect(
      owner.mutate(async ({ store }) => {
        await store.write("a.md", text("DKT-1", "done"));
        throw new Error("partial failure");
      }),
    ).rejects.toThrow("partial failure");
    resume.release();
    expect((await pending).snapshot.bundle.byId("DKT-1")?.fm.status).toBe(
      "done",
    );
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3].map((n) =>
        owner.mutate(async () => {
          order.push(n);
          await Promise.resolve();
          order.push(n);
        }),
      ),
    );
    expect(order).toEqual([1, 1, 2, 2, 3, 3]);
  } finally {
    resume.release();
    owner.close();
  }
});

test("resolver changes and close during refresh cannot retain the old repository", async () => {
  let store = new InMemoryFileStore(new Map([["a.md", text("DKT-1")]]));
  const owner = new RepositoryOwner(async () => ({
    store,
    config: parseConfig(),
  }));
  await owner.read();
  store = new InMemoryFileStore(new Map([["b.md", text("DKT-2")]]));
  expect((await owner.read()).snapshot.bundle.byId("DKT-1")).toBeUndefined();
  expect((await owner.read()).snapshot.bundle.byId("DKT-2")).toBeDefined();
  const entered = gate();
  const resume = gate();
  const read = store.read.bind(store);
  store.read = async (path) => {
    entered.release();
    await resume.promise;
    return read(path);
  };
  const pending = owner.read();
  await entered.promise;
  owner.close();
  owner.close();
  resume.release();
  await expect(pending).rejects.toThrow();
  expect(() => owner.read()).toThrow("closed");
});
