// Zod schemas for the OKF task profile. Two rules from OKF carry through
// everywhere: only `type` is required on a concept, and unknown types/fields
// are tolerated, never rejected (catchall + generic Concept fallback).

import { z } from "zod";
import type { DocketConfig } from "./config";
import { DECISION_STATES, PRIORITIES, STATES, WORK_ITEM_TYPES } from "./states";

const base = {
  type: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).default([]),
  aliases: z.array(z.string()).default([]),
};

export function buildSchemas(config: DocketConfig) {
  const workItemId = new RegExp(`^${config.project}-\\d+$`);
  const decisionId = new RegExp(`^${config.ids.decision_prefix}-\\d+$`);

  const workItem = z
    .object({
      ...base,
      type: z.enum(WORK_ITEM_TYPES),
      id: z.string().regex(workItemId, `expected ${config.project}-<n>`),
      status: z.enum(STATES),
      epic: z.string().optional(),
      spec: z.string().optional(),
      depends_on: z.array(z.string()).default([]),
      priority: z.enum(PRIORITIES).default("p2"),
      rank: z.number().optional(),
      assignee: z.string().optional(),
    })
    .catchall(z.unknown());

  const decision = z
    .object({
      ...base,
      type: z.literal("Decision"),
      id: z
        .string()
        .regex(decisionId, `expected ${config.ids.decision_prefix}-<n>`),
      status: z.enum(DECISION_STATES).default("accepted"),
      supersedes: z.string().optional(),
    })
    .catchall(z.unknown());

  const generic = z.object(base).catchall(z.unknown());

  return { workItem, decision, generic };
}

export type Schemas = ReturnType<typeof buildSchemas>;
export type WorkItemFrontmatter = z.infer<Schemas["workItem"]>;
export type DecisionFrontmatter = z.infer<Schemas["decision"]>;
export type GenericFrontmatter = z.infer<Schemas["generic"]>;
