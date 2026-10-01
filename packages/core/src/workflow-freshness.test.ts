import { expect, test } from "bun:test";
import { InMemoryFileStore } from "./filestore";
import { shippedHistory, shippedWorkflow } from "./shipped";
import { DOCKET_VERSION } from "./version";
import { readWorkflowFreshness } from "./workflow-freshness";

const path = "workflows/docket-pickup.md";
const source = (body: string, origin = `docket-pickup@${DOCKET_VERSION}`) =>
  `---\ntype: Workflow\ntitle: Pickup\norigin: ${origin}\n---\n\n${body}\n`;
test("actual current/historical/customized source beats its version stamp and absence is optional", async () => {
  const store = new InMemoryFileStore();
  expect((await readWorkflowFreshness(store)).status).toBe("absent");
  const current = shippedWorkflow("docket-pickup", DOCKET_VERSION);
  const old = shippedHistory().find(
    (h) =>
      h.version !== DOCKET_VERSION && h.bodies["docket-pickup"] !== current,
  );
  if (!current || !old?.bodies["docket-pickup"])
    throw new Error("Missing real shipped fixtures");
  await store.write(path, source(current));
  const exact = await readWorkflowFreshness(store);
  expect(exact.status).toBe("current");
  expect(exact.sourceVersion).toMatch(/^[a-f0-9]{64}$/);
  await store.write(
    path,
    source(old.bodies["docket-pickup"], `docket-pickup@${old.version}`),
  );
  expect((await readWorkflowFreshness(store)).status).toBe("outdated");
  await store.write(path, source(old.bodies["docket-pickup"]));
  expect((await readWorkflowFreshness(store)).status).toBe("review-required");
  await store.write(
    path,
    source(`${current}\n\nKeep the stricter owner test requirement.`),
  );
  const authored = await store.read(path);
  expect((await readWorkflowFreshness(store)).status).toBe("review-required");
  expect(await store.read(path)).toBe(authored);
  await store.write(
    path,
    source("Unknown custom instructions.", "mystery@9.9.9"),
  );
  expect((await readWorkflowFreshness(store)).status).toBe("unverifiable");
  await store.write(
    path,
    source(current).replace("type: Workflow", "type: Task"),
  );
  expect((await readWorkflowFreshness(store)).status).toBe("review-required");
});
