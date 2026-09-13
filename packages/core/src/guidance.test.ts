import { expect, test } from "bun:test";
import { loadBundle } from "./bundle";
import { parseConfig } from "./config";
import { InMemoryFileStore } from "./filestore";
import { PROJECT_GUIDANCE_PATH, readProjectGuidance } from "./guidance";
import { lintBundle } from "./lint";

const config = parseConfig();
const document = (body = "", type = "Reference") =>
  `---\ntype: ${type}\ntitle: Project guidance\n---\n${body}`;

test("valid empty frontmatter and encoded or protocol-relative links retain their meaning", async () => {
  const store = new InMemoryFileStore();
  for (const source of [
    "\uFEFF---\ntype: Reference\n---\n",
    "---\ntype: Reference\n---  \n",
    "---\r\ntype: Reference\r\n---\t\r\n",
  ]) {
    store.files.set(PROJECT_GUIDANCE_PATH, source);
    expect((await readProjectGuidance(store, config)).status).toBe("empty");
  }
  store.files.set(
    PROJECT_GUIDANCE_PATH,
    document(
      "[web](//example.com/guide.md) [API](api%20standards.md) [escape](%2e%2e/%2e%2e/secret.md)",
    ),
  );
  store.files.set(
    "reference/api standards.md",
    document("Selected API rules."),
  );
  const result = await readProjectGuidance(store, config);
  expect(result.links.map((link) => link.status)).toEqual([
    "external",
    "available",
    "unsupported",
  ]);
  expect(result.links[1]?.path).toBe("reference/api standards.md");
  expect(result.diagnostics).toHaveLength(1);
});

test("guidance lint diagnoses explicit reference links and conflicts while retirement preserves sources", async () => {
  const store = new InMemoryFileStore();
  const lint = async () => lintBundle(store, await loadBundle(store, config));
  expect(await lint()).toEqual([]);
  store.files.set(
    PROJECT_GUIDANCE_PATH,
    document(
      "When changing the backend API, follow [API][standard].\n\n[standard]: /reference/api.md\n",
    ),
  );
  expect((await readProjectGuidance(store, config)).links[0]?.status).toBe(
    "missing",
  );
  expect(
    (await lint()).some(
      (d) => d.severity === "error" && d.message.includes("guidance link"),
    ),
  ).toBe(true);
  const api = document("Requirement: use GraphQL.");
  store.files.set("reference/api.md", api);
  expect(await lint()).toEqual([]);
  store.files.set(
    PROJECT_GUIDANCE_PATH,
    document("No active instructions. Retirement recorded in Git."),
  );
  expect((await readProjectGuidance(store, config)).links).toEqual([]);
  expect(store.files.get("reference/api.md")).toBe(api);
  expect(await lint()).toEqual([]);
  store.files.set(
    PROJECT_GUIDANCE_PATH,
    document("<<<<<<< ours\nGraphQL\n=======\nREST\n>>>>>>> theirs\n"),
  );
  expect((await readProjectGuidance(store, config)).status).toBe("invalid");
  expect(
    (await lint()).some((d) => d.message.includes("competing instructions")),
  ).toBe(true);
  expect(store.files.get("reference/api.md")).toBe(api);
});

test("guidance distinguishes absent, empty, invalid and unreadable sources without writing", async () => {
  const store = new InMemoryFileStore();
  expect((await readProjectGuidance(store, config)).status).toBe("absent");
  expect(store.files.size).toBe(0);
  for (const [source, status] of [
    [document(), "empty"],
    ["", "invalid"],
    ["not a concept", "invalid"],
    [document("Steps", "Playbook"), "invalid"],
  ] as const) {
    store.files.set(PROJECT_GUIDANCE_PATH, source);
    expect((await readProjectGuidance(store, config)).status).toBe(status);
    expect(store.files.get(PROJECT_GUIDANCE_PATH)).toBe(source);
  }
  store.read = async () => {
    throw new Error("permission denied");
  };
  const unavailable = await readProjectGuidance(store, config);
  expect(unavailable.status).toBe("unavailable");
  expect(unavailable.diagnostics[0]?.message).toContain("permission denied");
});

test("scope stays in authored prose and explicit targets are diagnosed without loading procedures", async () => {
  const source = document(
    "# General standards\n\nRequirement: use TDD for behavioral changes.\n\n# Scoped guidance\n\nWhen changing backend APIs, follow [API standards](api.md).\nWhen a deployment is requested, follow [deployment](/playbooks/deploy.md). Saving this procedure is not permission to execute it.\n[missing](gone.md) [escape](../../secret.md) [web](https://example.com)\n",
  );
  const store = new InMemoryFileStore(
    new Map([
      [PROJECT_GUIDANCE_PATH, source],
      ["reference/api.md", document("Requirement: use GraphQL.")],
      ["playbooks/deploy.md", document("DO NOT eagerly read this", "Playbook")],
    ]),
  );
  const reads: string[] = [];
  const read = store.read.bind(store);
  store.read = async (path) => {
    reads.push(path);
    return read(path);
  };
  const result = await readProjectGuidance(store, config);
  expect(result.status).toBe("present");
  expect(result.source?.text).toBe(source);
  expect(result.links.map((link) => link.status)).toEqual([
    "available",
    "available",
    "missing",
    "unsupported",
    "external",
  ]);
  expect(result.diagnostics).toHaveLength(2);
  expect(reads).toEqual([PROJECT_GUIDANCE_PATH]);
});

test("long guidance returns a bounded exact page with explicit continuation", async () => {
  const store = new InMemoryFileStore(
    new Map([
      [PROJECT_GUIDANCE_PATH, document("A long standard. ".repeat(4000))],
    ]),
  );
  const result = await readProjectGuidance(store, config);
  expect(result.source?.text.length).toBeLessThanOrEqual(16384);
  expect(result.source?.nextCursor).toBeDefined();
});
