// Real layout check using the reading/preview renderer and shipped stylesheet.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { renderMarkdown } from "../packages/web/src/render";

const chrome =
  process.env.CHROME_BIN ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const root = await mkdtemp(join(tmpdir(), "docket-prose-browser-"));
try {
  const long =
    "Long prose should wrap naturally in the available reading width without inserting manual source breaks. "
      .repeat(10)
      .trim();
  const source = `${long}\n\n- ${long}\n\nIntentional break  \nnext line.\n`;
  const rendered = renderMarkdown("reference/prose.md", source);
  const css = await readFile(
    new URL("../packages/web/src/client/styles.css", import.meta.url),
    "utf8",
  );
  const html = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><article class="md">${rendered}</article><section class="editor-preview md">${rendered}</section><output id="receipt"></output><script>
const surfaces = [...document.querySelectorAll('.md')].map(element => {
  const paragraph = element.querySelector('p');
  const item = element.querySelector('li');
  const lineCount = node => {
    const range = document.createRange(); range.selectNodeContents(node);
    return new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size;
  };
  return { paragraphLines: lineCount(paragraph), itemLines: lineCount(item), forcedProseBreaks: paragraph.querySelectorAll('br').length + item.querySelectorAll('br').length, intentionalBreaks: element.querySelectorAll('br').length, overflow: element.scrollWidth > element.clientWidth + 1 };
});
document.querySelector('#receipt').textContent = JSON.stringify({ browser: navigator.userAgent, width: innerWidth, surfaces, pageOverflow: document.documentElement.scrollWidth > innerWidth });
</script>`;
  const page = join(root, "prose.html");
  await writeFile(page, html);
  const results = [];
  for (const width of [500, 1440]) {
    const child = Bun.spawn(
      [
        chrome,
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${join(root, `profile-${width}`)}`,
        `--window-size=${width},1000`,
        "--virtual-time-budget=1000",
        "--dump-dom",
        pathToFileURL(page).href,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const timeout = setTimeout(() => child.kill(), 20_000);
    const [dom, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    clearTimeout(timeout);
    assert.equal(code, 0, stderr);
    const receipt = dom.match(/<output id="receipt">([^<]+)<\/output>/)?.[1];
    assert(receipt, "browser must return actual layout measurements");
    const result = JSON.parse(receipt) as {
      browser: string;
      width: number;
      pageOverflow: boolean;
      surfaces: {
        paragraphLines: number;
        itemLines: number;
        forcedProseBreaks: number;
        intentionalBreaks: number;
        overflow: boolean;
      }[];
    };
    assert.equal(result.width, width);
    assert.equal(result.pageOverflow, false);
    assert.equal(result.surfaces.length, 2);
    for (const surface of result.surfaces) {
      assert(surface.paragraphLines > 1 && surface.itemLines > 1);
      assert.equal(surface.forcedProseBreaks, 0);
      assert.equal(surface.intentionalBreaks, 1);
      assert.equal(surface.overflow, false);
    }
    results.push(result);
  }
  assert(
    (results[0]?.surfaces[0]?.paragraphLines ?? 0) >
      (results[1]?.surfaces[0]?.paragraphLines ?? 0),
  );
  const receipt = {
    browser: results[0]?.browser,
    sourceParagraphCharacters: long.length,
    results,
  };
  await writeFile(
    new URL("./verification/markdown-prose-browser.json", import.meta.url),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
