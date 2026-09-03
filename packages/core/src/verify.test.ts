import { describe, expect, test } from "bun:test";
import { loadBundle } from "./bundle";
import { parseConfig } from "./config";
import { InMemoryFileStore } from "./filestore";
import {
  resolveVerifyMarkers,
  scanVerifyMarkers,
  verifyStatus,
} from "./verify";

const config = parseConfig();

// The token is split so this repo's own marker scan never reads these
// fixtures as markers (same discipline as quoting partial conflict markers).
const T = ["docket", "verifies"].join(":");

const files = {
  "specs/alpha.md": "---\ntype: Spec\ntitle: Alpha\n---\n\nx\n",
  "specs/beta.md": "---\ntype: Spec\ntitle: Beta\n---\n\nx\n",
  "reference/notes.md": "---\ntype: Reference\ntitle: Notes\n---\n\nx\n",
};

const bundle = () =>
  loadBundle(new InMemoryFileStore(new Map(Object.entries(files))), config);

describe("scanVerifyMarkers", () => {
  test("matches any comment syntax with 1-indexed lines", () => {
    const content = [
      `// ${T} /specs/alpha.md`,
      "code();",
      `# ${T} /specs/beta.md`,
      `<!-- ${T} /specs/alpha.md#rules -->`,
      `-- ${T} /specs/beta.md`,
    ].join("\n");
    const markers = scanVerifyMarkers("test/a.test.ts", content);
    expect(markers).toHaveLength(4);
    expect(markers[0]).toMatchObject({
      source: "test/a.test.ts",
      line: 1,
      target: "/specs/alpha.md",
    });
    expect(markers[1]?.line).toBe(3);
    expect(markers[2]).toMatchObject({
      line: 4,
      target: "/specs/alpha.md#rules",
      anchor: "rules",
    });
  });

  test("plain prose without the token yields nothing", () => {
    expect(scanVerifyMarkers("a.ts", "verifies /specs/alpha.md\n")).toEqual([]);
  });

  test("trailing debris is shed: comment closers, quotes, escapes", () => {
    const content = [
      `/* ${T} /specs/alpha.md */`,
      `"// ${T} /specs/beta.md\\nit();"`,
      `'${T} /specs/alpha.md#rules',`,
    ].join("\n");
    const targets = scanVerifyMarkers("a.ts", content).map((m) => m.target);
    expect(targets).toEqual([
      "/specs/alpha.md",
      "/specs/beta.md",
      "/specs/alpha.md#rules",
    ]);
  });
});

describe("resolveVerifyMarkers", () => {
  const paths = new Set(Object.keys(files));
  const marker = (target: string) => ({
    source: "a.test.ts",
    line: 1,
    target,
  });

  test("bundle-absolute existing target resolves; anchor kept out of spec", () => {
    const [m] = resolveVerifyMarkers([marker("/specs/alpha.md#rules")], paths);
    expect(m?.spec).toBe("specs/alpha.md");
  });

  test("missing, relative, and non-md targets stay unresolved", () => {
    const resolved = resolveVerifyMarkers(
      [marker("/specs/gone.md"), marker("specs/alpha.md"), marker("/README")],
      paths,
    );
    expect(resolved.map((m) => m.spec)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe("verifyStatus", () => {
  test("lists every Spec, flags the bare ones, includes targeted non-specs", async () => {
    const markers = resolveVerifyMarkers(
      scanVerifyMarkers(
        "test/a.test.ts",
        `// ${T} /specs/alpha.md#rules\n// ${T} /reference/notes.md\n`,
      ),
      new Set(Object.keys(files)),
    );
    const rows = verifyStatus(await bundle(), markers);
    expect(rows.map((r) => r.spec)).toEqual([
      "reference/notes.md",
      "specs/alpha.md",
      "specs/beta.md",
    ]);
    const [notes, alpha, beta] = rows;
    expect(alpha?.unverified).toBe(false);
    expect(alpha?.sources).toEqual([
      { source: "test/a.test.ts", line: 1, anchor: "rules" },
    ]);
    expect(beta?.unverified).toBe(true);
    expect(beta?.sources).toEqual([]);
    // Targeted non-spec appears but is never flagged — the zero signal is
    // for Specs only.
    expect(notes?.type).toBe("Reference");
    expect(notes?.unverified).toBe(false);
  });

  test("unresolved markers contribute nothing", async () => {
    const rows = verifyStatus(await bundle(), [
      { source: "a.ts", line: 1, target: "/specs/gone.md" },
    ]);
    expect(rows.every((r) => r.sources.length === 0)).toBe(true);
  });
});

describe("config verify key", () => {
  test("absent key is null — the feature's off switch", () => {
    expect(parseConfig("project: DKT\n").verify).toBeNull();
    expect(parseConfig().verify).toBeNull();
  });

  test("present key parses globs; junk entries drop", () => {
    const parsed = parseConfig(
      'project: DKT\nverify:\n  tests:\n    - "packages/**/*.test.ts"\n    - 7\n',
    );
    expect(parsed.verify).toEqual({ tests: ["packages/**/*.test.ts"] });
  });

  test("empty verify section is on, with no globs", () => {
    expect(parseConfig("verify: {}\n").verify).toEqual({ tests: [] });
  });
});
