// docket.yaml — parsed with explicit defaults rather than schema magic so a
// missing or partial config always yields a fully-populated DocketConfig.
// Unknown keys are preserved (OKF-style tolerance applies to config too).

import { parse as parseYaml } from "yaml";
import { STATES } from "./states";

export interface DocketConfig {
  project: string;
  bundle: string;
  ids: { scheme: string; decision_prefix: string };
  workflow: { states: readonly string[] };
  git: { trailer: string; branch_prefix: string };
  /** Verification linkage. null = key absent = feature fully dormant. */
  verify: { tests: string[] } | null;
  extra: Record<string, unknown>;
}

export const CONFIG_FILENAME = "docket.yaml";

/** Default bundle root — a Docket-signaling name that doesn't collide
 * with a repo's existing docs/ folder. Repos with an explicit `bundle:` keep it. */
export const DEFAULT_BUNDLE = "docket/";

export function parseConfig(source?: string): DocketConfig {
  const raw: Record<string, unknown> =
    source &&
    typeof parseYaml(source) === "object" &&
    parseYaml(source) !== null
      ? (parseYaml(source) as Record<string, unknown>)
      : {};

  const section = (key: string): Record<string, unknown> => {
    const value = raw[key];
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  };
  const str = (value: unknown, fallback: string): string =>
    typeof value === "string" && value.length > 0 ? value : fallback;

  const ids = section("ids");
  const workflow = section("workflow");
  const git = section("git");
  const configuredStates = Array.isArray(workflow.states)
    ? workflow.states.filter((s): s is string => typeof s === "string")
    : [...STATES];
  // Canonical states are engine semantics, not optional feature flags. Append
  // newly introduced states for older adopting configs so upgraded clients can
  // expose them without rewriting the user's docket.yaml.
  const states = [
    ...configuredStates,
    ...STATES.filter((state) => !configuredStates.includes(state)),
  ];

  // verify: the whole feature's on/off switch is this key's presence.
  const verifySection = section("verify");
  const verify =
    "verify" in raw
      ? {
          tests: Array.isArray(verifySection.tests)
            ? verifySection.tests.filter(
                (g): g is string => typeof g === "string",
              )
            : [],
        }
      : null;

  const known = new Set([
    "project",
    "bundle",
    "ids",
    "workflow",
    "git",
    "verify",
  ]);
  const extra = Object.fromEntries(
    Object.entries(raw).filter(([k]) => !known.has(k)),
  );

  return {
    project: str(raw.project, "DKT"),
    bundle: str(raw.bundle, DEFAULT_BUNDLE),
    ids: {
      scheme: str(ids.scheme, "sequential"),
      decision_prefix: str(ids.decision_prefix, "DEC"),
    },
    workflow: { states },
    git: {
      trailer: str(git.trailer, "Task"),
      branch_prefix: str(git.branch_prefix, "task/"),
    },
    verify,
    extra,
  };
}
