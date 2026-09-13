import { expect, test } from "bun:test";
import remarkParse from "remark-parse";
import { unified } from "unified";
import {
  appendActiveGuidance,
  guidanceEntries,
  procedureDestination,
} from "./guidance-tools";

test("retirement spans preserve surrounding entries, headings and fenced examples", () => {
  const body =
    "# Standards\n\n- Keep this.\n- Retire this.\n  Continuation and [procedure](/playbooks/run.md).\n\n```md\n- Example, not an entry.\n```\n\nKeep this paragraph.\n";
  const entries = guidanceEntries(body);
  expect(entries).toHaveLength(3);
  const target = entries[1];
  if (!target) throw new Error("Missing entry");
  const retired = body.slice(0, target.start) + body.slice(target.end);
  expect(retired).toContain("# Standards\n\n- Keep this.");
  expect(retired).not.toContain("Continuation");
  expect(retired).toContain("```md\n- Example, not an entry.\n```");
  expect(retired).toContain("Keep this paragraph.");
});

test("new active entries escape retired sections and reject an unclosed example fence", () => {
  const body = "# Retired guidance\n\n- Old standard.\n";
  expect(appendActiveGuidance(body, "- New standard.")).toBe(
    `${body.trimEnd()}\n\n# Active guidance\n\n- New standard.\n`,
  );
  expect(() =>
    appendActiveGuidance("# Example\n\n```md\ntext", "- New."),
  ).toThrow("Close the final");
  expect(() => appendActiveGuidance("<!-- inactive notes", "- New.")).toThrow(
    "Close the final",
  );
  expect(() => appendActiveGuidance("```", "- New.")).toThrow(
    "Close the final",
  );
  expect(appendActiveGuidance("```md\ntext\n```\n", "- New.")).toContain(
    "```\n\n# Active guidance",
  );
});
test("procedure links preserve legal filename punctuation", () => {
  const target = procedureDestination("playbooks/deploy).md");
  const tree = unified().use(remarkParse).parse(`[Deploy](${target})`);
  const first = tree.children[0];
  if (first?.type !== "paragraph" || first.children[0]?.type !== "link")
    throw new Error("Link did not parse");
  expect(decodeURIComponent(first.children[0].url)).toBe(
    "/playbooks/deploy).md",
  );
});
