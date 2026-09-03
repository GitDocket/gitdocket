import { describe, expect, test } from "bun:test";
import {
  parseStateOfPlay,
  presentStateOfPlay,
  REENTRY_CONTEXT_FORMAT,
  REENTRY_CONTEXT_V1_FORMAT,
  STATE_OF_PLAY_PATH,
} from "./state-of-play";

const structured = `---
format: re-entry/v2
as_of: abc1234
reviewed_at: 2026-08-20T20:00:00Z
---

# Project re-entry

## What we've done recently

- Shipped a [shared overview](/work/tasks/DKT-82.md) for humans and agents.

## What's up next

- Simplify [Home](/work/epics/DKT-92.md) around one linked summary.

## Worth knowing

- [Derived truth remains separate](/decisions/DEC-8.md) from authored judgment.
`;

const v1 = `---
format: re-entry/v1
as_of: abc1234
reviewed_at: 2026-08-20T20:00:00Z
---

## Product orientation

Docket keeps project knowledge and work in one linked graph.

## Current outcome

A returning reader can recover the product direction quickly.

## Current bet

A small authored checkpoint plus derived execution is enough.

## Evidence and learning

The existing prose proved too abstract in dogfooding.

## Principal risk

The checkpoint could duplicate live task state.

## Next decision

Decide whether the structured context survives a real re-entry.

## Material decisions

- [Derived truth, authored judgment](/decisions/DEC-8.md)
`;

describe("product context", () => {
  test("parses the small linked re-entry note", () => {
    const parsed = parseStateOfPlay(structured);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.note).toEqual({
      format: REENTRY_CONTEXT_FORMAT,
      asOf: "abc1234",
      reviewedAt: "2026-08-20T20:00:00Z",
      body: expect.stringContaining("## What we've done recently"),
      recent:
        "- Shipped a [shared overview](/work/tasks/DKT-82.md) for humans and agents.",
      next: "- Simplify [Home](/work/epics/DKT-92.md) around one linked summary.",
      worthKnowing:
        "- [Derived truth remains separate](/decisions/DEC-8.md) from authored judgment.",
      links: [
        "/work/tasks/DKT-82.md",
        "/work/epics/DKT-92.md",
        "/decisions/DEC-8.md",
      ],
      decisionLinks: ["/decisions/DEC-8.md"],
    });
  });

  test("keeps re-entry/v1 readable but marks it as superseded", () => {
    const parsed = parseStateOfPlay(v1);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.note).toEqual(
      expect.objectContaining({
        format: REENTRY_CONTEXT_V1_FORMAT,
        orientation:
          "Docket keeps project knowledge and work in one linked graph.",
        assessment: expect.objectContaining({
          decisionLinks: ["/decisions/DEC-8.md"],
        }),
      }),
    );
    if (!parsed.note) throw new Error("v1 note did not parse");
    expect(
      presentStateOfPlay(parsed.note, 0, {
        now: new Date("2026-08-21T20:00:00Z"),
      }).review.reasons,
    ).toEqual(["superseded-format"]);
  });

  test("permits Worth knowing to disappear and rejects missing required sections", () => {
    const withoutOptional = structured.replace(
      /\n## Worth knowing[\s\S]*$/,
      "\n",
    );
    const parsed = parseStateOfPlay(withoutOptional);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.note).not.toHaveProperty("worthKnowing");

    const incomplete = parseStateOfPlay(
      withoutOptional.replace(/\n## What's up next[\s\S]*$/, "\n"),
    );
    expect(incomplete.note).toBeUndefined();
    expect(
      incomplete.diagnostics.map((item) => item.message).join("\n"),
    ).toContain("what's up next");
  });

  test("keeps legacy prose readable without pretending it is current", () => {
    const parsed = parseStateOfPlay(
      "---\nas_of: abc1234\nupdated_at: 2026-08-20T20:00:00Z\n---\n\nThe through-line is **clear**.\n",
    );
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.note).toEqual({
      format: "legacy",
      asOf: "abc1234",
      updatedAt: "2026-08-20T20:00:00Z",
      body: "The through-line is **clear**.",
    });
    if (!parsed.note) throw new Error("legacy note did not parse");
    expect(
      presentStateOfPlay(parsed.note, 0, {
        now: new Date("2026-08-21T20:00:00Z"),
      }).review,
    ).toEqual({
      status: "needs-review",
      reasons: ["legacy-format"],
      reviewedDaysAgo: 1,
      maxDays: 14,
    });
  });

  test("rejects malformed metadata and incomplete structured context", () => {
    const missing = parseStateOfPlay("No frontmatter.\n");
    expect(missing.note).toBeUndefined();
    expect(missing.diagnostics[0]?.path).toBe(STATE_OF_PLAY_PATH);

    const invalid = parseStateOfPlay(
      "---\nformat: re-entry/v2\nas_of: nope\nreviewed_at: yesterday\n---\n\n## What we've done recently\n\nOnly one section.\n",
    );
    expect(invalid.note).toBeUndefined();
    const messages = invalid.diagnostics.map((d) => d.message).join("\n");
    expect(messages).toContain("hexadecimal commit SHA");
    expect(messages).toContain("`reviewed_at` must be an ISO-8601 string");
    expect(messages).toContain("what's up next");
  });

  test("note freshness reacts to evidence movement and elapsed review time", () => {
    const note = parseStateOfPlay(structured).note;
    if (!note) throw new Error("structured note did not parse");
    expect(
      presentStateOfPlay(note, 0, {
        now: new Date("2026-08-21T20:00:00Z"),
      }).review.status,
    ).toBe("current");

    expect(
      presentStateOfPlay(note, 5, {
        now: new Date("2026-08-21T20:00:00Z"),
      }).review,
    ).toEqual({
      status: "needs-review",
      reasons: ["evidence-moved"],
      reviewedDaysAgo: 1,
      maxDays: 14,
    });

    expect(
      presentStateOfPlay(note, 0, {
        now: new Date("2026-09-03T20:00:00Z"),
      }).review.reasons,
    ).toContain("review-expired");
  });

  test("presentation carries an honest unknown evidence age when Git is unavailable", () => {
    const note = parseStateOfPlay(structured).note;
    if (!note) throw new Error("structured note did not parse");
    expect(
      presentStateOfPlay(note, undefined, {
        now: new Date("2026-08-21T20:00:00Z"),
      }).review,
    ).toEqual({
      status: "age-unavailable",
      reasons: ["git-age-unavailable"],
      reviewedDaysAgo: 1,
      maxDays: 14,
    });
  });
});
