import { test } from "bun:test";
import { runUpgrade } from "../packages/cli/src/upgrade";
import { shippedHistory } from "../packages/core/src/shipped";
import { DOCKET_VERSION } from "../packages/core/src/version";
import { verifyUpgradeCompatibility } from "./upgrade-compatibility";

// docket:verifies DKT-272 — this runs the shared customized/stale epic checks.
test("historical upgrades propagate current behavior and expose stale retained text", async () => {
  await verifyUpgradeCompatibility({
    history: shippedHistory(),
    version: DOCKET_VERSION,
    upgrade: (root, dryRun) => runUpgrade(root, { dryRun }),
  });
}, 20_000);
