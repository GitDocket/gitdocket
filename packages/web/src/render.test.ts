import { expect, test } from "bun:test";
import { renderMarkdown } from "./render";

test("reading and preview renderer leave long prose to browser wrapping and retain explicit breaks", () => {
  const long =
    "A long paragraph stays on one source line and wraps in its reading environment. "
      .repeat(8)
      .trim();
  const html = renderMarkdown("reference/prose.md", `${long}\n\n- ${long}\n`);
  expect(html).toContain(`<p>${long}</p>`);
  expect(html).toContain(`<li>${long}</li>`);
  expect(html).not.toContain("<br");
  const intentional = renderMarkdown(
    "reference/prose.md",
    "First  \nsecond\\\nthird.\n\n```text\nline one\nline two\n```",
  );
  expect(intentional.match(/<br>/g)).toHaveLength(2);
  expect(intentional).toContain("line one\nline two\n");
});
