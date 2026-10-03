import { test } from "bun:test";
import { runUpgrade } from "../packages/cli/src/upgrade";
import { shippedHistory } from "../packages/core/src/shipped";
import { DOCKET_VERSION } from "../packages/core/src/version";
import { verifyUpgradeCompatibility } from "./upgrade-compatibility";

// docket:verifies DKT-289 — current-state writing reaches historical/customized workflows; stale stamps remain review-required.
// docket:verifies DKT-272 — this runs the shared customized/stale epic checks.
// docket:verifies DKT-292 — authority-first pickup and independent-child progress reach historical/customized adopters; stale stamped copies require review.
test("historical upgrades propagate current behavior and expose stale retained text", async () => {
  await verifyUpgradeCompatibility({
    history: shippedHistory(),
    version: DOCKET_VERSION,
    upgrade: (root, dryRun) => runUpgrade(root, { dryRun }),
  });
}, 20_000);
