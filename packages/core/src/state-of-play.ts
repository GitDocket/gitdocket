// Agent-authored product context. The engine parses and
// presents committed judgment; it never authors it. overview.md is a reserved
// bundle-root file so it stays out of the concept graph and generated index.

import { parse as parseYaml } from "yaml";
import type { Diagnostic } from "./parse";

export const STATE_OF_PLAY_PATH = "overview.md";
/** Evidence movement that makes an authored re-entry note worth revisiting. */
export const STATE_OF_PLAY_STALE_COMMITS = 5;
/** A quiet project must still review its last-known context occasionally. */
export const STATE_OF_PLAY_REVIEW_MAX_DAYS = 14;
export const REENTRY_CONTEXT_FORMAT = "re-entry/v2" as const;
export const REENTRY_CONTEXT_V1_FORMAT = "re-entry/v1" as const;

interface StateOfPlayBase {
  /** Commit the authored judgment was written against. */
  asOf: string;
  /** Markdown after the machine-readable frontmatter. */
  body: string;
}

/** The legacy prose format. It remains readable but is never current. */
export interface LegacyStateOfPlayNote extends StateOfPlayBase {
  format: "legacy";
  updatedAt?: string;
}

/** The superseded assessment shape, retained for read compatibility. */
export interface ReentryAssessment {
  outcome: string;
  bet: string;
  evidence: string;
  risk: string;
  nextDecision: string;
  decisions: string;
  decisionLinks: string[];
}

export interface ReentryV1ContextNote extends StateOfPlayBase {
  format: typeof REENTRY_CONTEXT_V1_FORMAT;
  reviewedAt: string;
  orientation: string;
  assessment: ReentryAssessment;
}

/** A small linked note: recent outcomes, the frontier, and optional context. */
export interface ReentryContextNote extends StateOfPlayBase {
  format: typeof REENTRY_CONTEXT_FORMAT;
  reviewedAt: string;
  recent: string;
  next: string;
  worthKnowing?: string;
  links: string[];
  decisionLinks: string[];
}

export type StateOfPlayNote =
  | LegacyStateOfPlayNote
  | ReentryV1ContextNote
  | ReentryContextNote;

export type StateOfPlayReviewReason =
  | "legacy-format"
  | "superseded-format"
  | "evidence-moved"
  | "review-expired"
  | "git-age-unavailable";

export interface StateOfPlayReview {
  /** Whether the last-known authored context should be revisited. */
  status: "current" | "needs-review" | "age-unavailable";
  reasons: StateOfPlayReviewReason[];
  reviewedDaysAgo: number | null;
  maxDays: number;
}

export type StateOfPlayView = StateOfPlayNote & {
  /** Null when Git cannot resolve the watermark (for example outside a repo). */
  taskCommitsAgo: number | null;
  review: StateOfPlayReview;
};

export interface StateOfPlayParseResult {
  note?: StateOfPlayNote;
  diagnostics: Diagnostic[];
}

export interface StateOfPlayPresentationOptions {
  now?: Date;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const COMMIT_SHA = /^[0-9a-f]{7,40}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

const V1_SECTION_NAMES = {
  "product orientation": "orientation",
  "current outcome": "outcome",
  "current bet": "bet",
  "evidence and learning": "evidence",
  "principal risk": "risk",
  "next decision": "nextDecision",
  "material decisions": "decisions",
} as const;

const SECTION_NAMES = {
  "what we've done recently": "recent",
  "what's up next": "next",
  "worth knowing": "worthKnowing",
} as const;

type V1SectionKey = (typeof V1_SECTION_NAMES)[keyof typeof V1_SECTION_NAMES];
type SectionKey = (typeof SECTION_NAMES)[keyof typeof SECTION_NAMES];

function structuredSections(
  body: string,
  diagnostics: Diagnostic[],
  names: Record<string, string>,
  required: string[],
): Record<string, string> {
  const sections: Record<string, string> = {};
  const headings = [...body.matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)];
  for (const [index, heading] of headings.entries()) {
    const name = heading[1]?.trim().toLowerCase() ?? "";
    const key = names[name];
    if (!key) continue;
    const start = (heading.index ?? 0) + heading[0].length;
    const end = headings[index + 1]?.index ?? body.length;
    const value = body.slice(start, end).trim();
    if (sections[key] !== undefined) {
      diagnostics.push({
        path: STATE_OF_PLAY_PATH,
        message: `duplicate \`## ${heading[1]?.trim()}\` section`,
        severity: "error",
      });
    } else {
      sections[key] = value;
    }
  }

  for (const heading of required) {
    const key = names[heading];
    if (!key || !sections[key]) {
      diagnostics.push({
        path: STATE_OF_PLAY_PATH,
        message: `structured product context requires a non-empty \`## ${heading}\` section`,
        severity: "error",
      });
    }
  }
  return sections;
}

const markdownLinks = (markdown: string): string[] =>
  [...markdown.matchAll(/\]\(([^)]+)\)/g)].map((link) => link[1] ?? "");

const validIsoDate = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));

/** Parse overview.md without treating it as an OKF concept. */
export function parseStateOfPlay(source: string): StateOfPlayParseResult {
  const diagnostics: Diagnostic[] = [];
  const match = source.match(FRONTMATTER);
  if (!match) {
    return {
      diagnostics: [
        {
          path: STATE_OF_PLAY_PATH,
          message: "missing YAML frontmatter with an `as_of` commit SHA",
          severity: "error",
        },
      ],
    };
  }

  let raw: unknown;
  try {
    raw = parseYaml(match[1] ?? "");
  } catch (error) {
    return {
      diagnostics: [
        {
          path: STATE_OF_PLAY_PATH,
          message: `invalid YAML: ${String(error)}`,
          severity: "error",
        },
      ],
    };
  }
  const fm =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  const asOf = fm.as_of;
  if (typeof asOf !== "string" || !COMMIT_SHA.test(asOf)) {
    diagnostics.push({
      path: STATE_OF_PLAY_PATH,
      message: "`as_of` must be a 7–40 character hexadecimal commit SHA",
      severity: "error",
    });
  }

  const body = source.slice(match[0].length).trim();
  if (!body) {
    diagnostics.push({
      path: STATE_OF_PLAY_PATH,
      message: "product-context body is empty",
      severity: "error",
    });
  }

  const format = fm.format;
  if (format === undefined) {
    const updatedAt = fm.updated_at;
    if (updatedAt !== undefined && !validIsoDate(updatedAt)) {
      diagnostics.push({
        path: STATE_OF_PLAY_PATH,
        message: "`updated_at` must be an ISO-8601 string when present",
        severity: "error",
      });
    }
    if (diagnostics.length > 0 || typeof asOf !== "string")
      return { diagnostics };
    return {
      note: {
        format: "legacy",
        asOf,
        ...(typeof updatedAt === "string" ? { updatedAt } : {}),
        body,
      },
      diagnostics,
    };
  }

  if (
    format !== REENTRY_CONTEXT_FORMAT &&
    format !== REENTRY_CONTEXT_V1_FORMAT
  ) {
    diagnostics.push({
      path: STATE_OF_PLAY_PATH,
      message: `unsupported product-context format: ${String(format)}`,
      severity: "error",
    });
    return { diagnostics };
  }

  const reviewedAt = fm.reviewed_at;
  if (!validIsoDate(reviewedAt)) {
    diagnostics.push({
      path: STATE_OF_PLAY_PATH,
      message: "`reviewed_at` must be an ISO-8601 string",
      severity: "error",
    });
  }
  const sections =
    format === REENTRY_CONTEXT_V1_FORMAT
      ? structuredSections(
          body,
          diagnostics,
          V1_SECTION_NAMES,
          Object.keys(V1_SECTION_NAMES),
        )
      : structuredSections(body, diagnostics, SECTION_NAMES, [
          "what we've done recently",
          "what's up next",
        ]);
  if (
    diagnostics.length > 0 ||
    typeof asOf !== "string" ||
    typeof reviewedAt !== "string"
  )
    return { diagnostics };

  if (format === REENTRY_CONTEXT_V1_FORMAT) {
    const legacySections = sections as Partial<Record<V1SectionKey, string>>;
    const decisions = legacySections.decisions ?? "";
    return {
      note: {
        format: REENTRY_CONTEXT_V1_FORMAT,
        asOf,
        reviewedAt,
        body,
        orientation: legacySections.orientation ?? "",
        assessment: {
          outcome: legacySections.outcome ?? "",
          bet: legacySections.bet ?? "",
          evidence: legacySections.evidence ?? "",
          risk: legacySections.risk ?? "",
          nextDecision: legacySections.nextDecision ?? "",
          decisions,
          decisionLinks: markdownLinks(decisions),
        },
      },
      diagnostics,
    };
  }

  const currentSections = sections as Partial<Record<SectionKey, string>>;
  const recent = currentSections.recent ?? "";
  const next = currentSections.next ?? "";
  const worthKnowing = currentSections.worthKnowing;
  const links = markdownLinks(
    [recent, next, worthKnowing].filter(Boolean).join("\n"),
  );
  return {
    note: {
      format: REENTRY_CONTEXT_FORMAT,
      asOf,
      reviewedAt,
      body,
      recent,
      next,
      ...(worthKnowing ? { worthKnowing } : {}),
      links,
      decisionLinks: links.filter((link) =>
        link.replace(/^\//, "").startsWith("decisions/"),
      ),
    },
    diagnostics,
  };
}

export function presentStateOfPlay(
  note: StateOfPlayNote,
  taskCommitsAgo: number | undefined,
  options: StateOfPlayPresentationOptions = {},
): StateOfPlayView {
  const reviewedAt =
    note.format === "legacy" ? note.updatedAt : note.reviewedAt;
  const reviewedTime = reviewedAt ? Date.parse(reviewedAt) : Number.NaN;
  const reviewedDaysAgo = Number.isNaN(reviewedTime)
    ? null
    : Math.max(
        0,
        Math.floor(
          ((options.now ?? new Date()).getTime() - reviewedTime) / DAY_MS,
        ),
      );
  const reasons: StateOfPlayReviewReason[] = [];
  if (note.format === "legacy") reasons.push("legacy-format");
  if (note.format === REENTRY_CONTEXT_V1_FORMAT)
    reasons.push("superseded-format");
  if ((taskCommitsAgo ?? 0) >= STATE_OF_PLAY_STALE_COMMITS)
    reasons.push("evidence-moved");
  if (
    reviewedDaysAgo !== null &&
    reviewedDaysAgo >= STATE_OF_PLAY_REVIEW_MAX_DAYS
  )
    reasons.push("review-expired");
  if (taskCommitsAgo === undefined) reasons.push("git-age-unavailable");

  const needsReview = reasons.some(
    (reason) => reason !== "git-age-unavailable",
  );
  return {
    ...note,
    taskCommitsAgo: taskCommitsAgo ?? null,
    review: {
      status: needsReview
        ? "needs-review"
        : taskCommitsAgo === undefined
          ? "age-unavailable"
          : "current",
      reasons,
      reviewedDaysAgo,
      maxDays: STATE_OF_PLAY_REVIEW_MAX_DAYS,
    },
  };
}
