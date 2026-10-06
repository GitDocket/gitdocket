import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { identitySvg } from "../packages/web/src/identity";

const root = join(import.meta.dir, "..");
const imagePath = join(root, "site/assets/social-preview.png");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<title>GitDocket: docs, tasks and decisions together in Git</title>
<rect width="1200" height="630" fill="#f5f3eb"/>
<svg x="64" y="58" width="430" height="90" viewBox="0 0 306 64">${identitySvg("primary", true).replace(/^<svg[^>]*>|<\/svg>$/g, "")}</svg>
<g font-family="sans-serif" fill="#182019">
<text x="64" y="218" font-size="22" letter-spacing="3" fill="#286b4c">PROJECT MEMORY, IN GIT</text>
<text x="64" y="296" font-size="64" font-weight="700">Docs, tasks and decisions.</text>
<text x="64" y="362" font-size="49">Together in your repository.</text>
<g fill="#ffffff" stroke="#b7c8ba" stroke-width="2"><rect x="64" y="424" width="300" height="88" rx="16"/><rect x="450" y="424" width="300" height="88" rx="16"/><rect x="836" y="424" width="300" height="88" rx="16"/></g>
<g font-size="34" text-anchor="middle"><text x="214" y="480">Work</text><text x="600" y="480">Decision</text><text x="986" y="480">Next session</text></g>
<g fill="#286b4c" font-size="48"><text x="390" y="485">→</text><text x="776" y="485">→</text></g>
<text x="64" y="582" font-size="25" fill="#49634f">gitdocket.com · public preview</text>
</g></svg>\n`;
await writeFile(join(root, "site/assets/social-preview.svg"), svg);
if (!process.argv.includes("--metadata")) {
  console.log(
    "Wrote social-preview.svg; rasterize to 1200×630 PNG, then rerun with --metadata.",
  );
  process.exit(0);
}
const image = await readFile(imagePath);
if (
  image.toString("hex", 0, 8) !== "89504e470d0a1a0a" ||
  image.readUInt32BE(16) !== 1200 ||
  image.readUInt32BE(20) !== 630
) {
  throw new Error("Expected a 1200×630 PNG social card");
}
const digest = createHash("sha256").update(image).digest("hex").slice(0, 12);
const url = `https://gitdocket.com/assets/social-preview.png?v=${digest}`;
const alt =
  "GitDocket logo above ‘Docs, tasks and decisions. Together in your repository.’ Linked Work, Decision and Next session cards illustrate carrying project context forward in Git.";
for await (const path of new Bun.Glob("**/*.html").scan(join(root, "site"))) {
  const full = join(root, "site", path);
  const source = await readFile(full, "utf8");
  const metadata = `<meta property="og:image" content="${url}">\n<meta property="og:image:type" content="image/png">\n<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">\n<meta property="og:image:alt" content="${alt}">\n<meta name="twitter:card" content="summary_large_image">\n<meta name="twitter:image" content="${url}">\n<meta name="twitter:image:alt" content="${alt}">`;
  await writeFile(
    full,
    source
      .replace(
        /^[ \t]*<meta (?:property="og:image(?::[^"]*)?"|name="twitter:(?:card|image(?::[^"]*)?)")[^>]*>[ \t]*\n?/gm,
        "",
      )
      .replace(
        /^[ \t]*<\/head>/m,
        `${metadata
          .split("\n")
          .map((line) => `    ${line}`)
          .join("\n")}\n  </head>`,
      ),
  );
}
console.log("Refreshed Open Graph and Twitter image metadata.");
