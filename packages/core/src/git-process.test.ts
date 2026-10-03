import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitProcessPool } from "./git-process";

const roots: string[] = [];
const pools: GitProcessPool[] = [];
afterEach(() => {
  for (const pool of pools.splice(0)) pool.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "docket-git-batch-"));
  roots.push(root);
  expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
  const blob = (bytes: Buffer) => {
    const result = Bun.spawnSync(["git", "hash-object", "-w", "--stdin"], {
      cwd: root,
      stdin: bytes,
    });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().trim();
  };
  return { root, blob };
}
test("batch blobs use exact byte framing for UTF-8, embedded line breaks, empty and invalid UTF-8 content", async () => {
  const { root, blob } = fixture();
  const values = [
    Buffer.from("😀\n123 blob 5\nbody\n"),
    Buffer.alloc(0),
    Buffer.from([0xff, 0x0a, 0x00, 0xfe]),
  ];
  const hashes = values.map(blob);
  const commands: string[][] = [];
  const pool = new GitProcessPool({ onCommand: (args) => commands.push(args) });
  pools.push(pool);
  const result = await pool.blobs(root, [...hashes, hashes[0] as string]);
  for (let i = 0; i < hashes.length; i++)
    expect(result.get(hashes[i] as string)).toEqual(values[i]);
  expect(commands).toEqual([["cat-file", "--batch"]]);
});
test("batch reads reject missing objects, invalid identities, oversize output and closed owners", async () => {
  const { root, blob } = fixture();
  const hash = blob(Buffer.alloc(100, 65));
  const pool = new GitProcessPool({ maxBytes: 80 });
  pools.push(pool);
  await expect(pool.blobs(root, [hash])).rejects.toThrow("byte budget");
  await expect(pool.blobs(root, ["-a"])).rejects.toThrow(
    "Invalid Git blob batch",
  );
  await expect(pool.blobs(root, Array(17).fill(hash))).rejects.toThrow(
    "Invalid Git blob batch",
  );
  const other = new GitProcessPool();
  pools.push(other);
  await expect(other.blobs(root, ["a".repeat(40)])).rejects.toThrow(
    "invalid object evidence",
  );
  other.close();
  await expect(other.blobs(root, [hash])).rejects.toThrow();
});
