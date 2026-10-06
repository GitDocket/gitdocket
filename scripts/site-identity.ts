import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { identitySvg } from "../packages/web/src/identity";

const root = join(import.meta.dir, "..");
await mkdir(join(root, "site/assets/identity"), { recursive: true });
for (const variant of ["primary", "dark", "mono"] as const) {
  for (const lockup of [false, true]) {
    await writeFile(
      join(
        root,
        `site/assets/identity/${lockup ? "wordmark" : "mark"}-${variant}.svg`,
      ),
      `${identitySvg(variant, lockup)}\n`,
    );
  }
}
await writeFile(join(root, "site/favicon.svg"), `${identitySvg()}\n`);
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 12);
const faviconHash = hash(
  await readFile(join(root, "site/favicon.svg"), "utf8"),
);
const redirectsPath = join(root, "site/_redirects");
const redirects = await readFile(redirectsPath, "utf8").catch(() => "");
const otherRedirects = redirects
  .split("\n")
  .filter((line) => line.trim() && !line.startsWith("/favicon.ico "));
await writeFile(
  redirectsPath,
  `${[...otherRedirects, `/favicon.ico /favicon.svg?v=${faviconHash} 301`].join("\n")}\n`,
);
const markHash = hash(
  await readFile(join(root, "site/assets/identity/mark-primary.svg"), "utf8"),
);
const cssHash = hash(await readFile(join(root, "site/styles.css"), "utf8"));
for await (const path of new Bun.Glob("**/*.html").scan(join(root, "site"))) {
  const full = join(root, "site", path);
  let text = await readFile(full, "utf8");
  text = text
    .replace(
      /href="\/favicon.svg(?:\?v=[a-f0-9]+)?"/g,
      `href="/favicon.svg?v=${faviconHash}"`,
    )
    .replace(
      /src="\/assets\/identity\/mark-primary.svg(?:\?v=[a-f0-9]+)?"/g,
      `src="/assets/identity/mark-primary.svg?v=${markHash}"`,
    )
    .replace(
      /href="\/styles.css\?v=[a-f0-9]+"/g,
      `href="/styles.css?v=${cssHash}"`,
    );
  await writeFile(full, text);
}
console.log(
  "Generated identity variants and refreshed favicon/mark/CSS cache hashes.",
);
