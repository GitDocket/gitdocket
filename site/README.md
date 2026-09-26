# Website deployment

The site is static: no package install, build step, server runtime, analytics, cookies, or third-party requests. The homepage and installation page load one local script, `site/copy-install.js`, so the Homebrew command can be copied. That script is the only script the content security policy allows, and only from this site.

For Cloudflare Pages:

- Production branch: `main`
- Framework preset: None
- Build command: leave blank
- Build output directory: `site`
- Root directory: repository root

The homepage leads with picking up where you left off, a plain Homebrew installation action, a product screenshot, one example of carrying a decision into the next session, team workflows and the OKF v0.1 foundation. The Board screenshot expands on demand. The beginner path starts with one task. Getting started, Everyday use, Epics and the extension reference render the corresponding `docs/` Markdown. Installation combines the user-facing portions of `docs/homebrew.md` and `docs/npm.md`, leaving their maintainer procedures in Markdown. The homepage, Extensions overview, recorded examples and CLI/MCP/HTTP summaries are curated pages; keep their explanations consistent with those sources. Keep setup aligned with `docs/getting-started.md`; verify CLI examples against command help and MCP schemas against a real `tools/list` response.

The extension reading path is `/docs/extensions/` → `/docs/extensions/beacon/` → `/docs/extensions/reference/`. The overview explains the benefit; Beacon shows actual excerpted delivery records and versioned installation setup; the reference renders `docs/extensions.md` with its Beacon links mapped to the site walkthrough. Keep the reference in sync with that Markdown source. `site/demo/product-delivery/` retains verbatim qualified artifact excerpts, source hashes, assistance and limits. Do not turn supplied test review into observed human approval, or the assisted browser check into an unattended run.

GitDocket 0.6.0 is the current public release: Homebrew supplies both commands from the project tap, npm is the Node-based alternative, Cursor is a first-class harness, and workflow extensions remain included as a preview. The public guides explain wiki creation and recoverable moves, accepted Decisions, local Mermaid rendering, and task progress across linked worktrees. Operator-only release workflow changes are omitted from the marketing site. The example app still requires Bun independently of GitDocket. Rebuild its source archive with `bun scripts/extensions/package-examples.ts` after changing docs/examples, then independently extract and verify the manifest and prepared-project links.

`site/docs/mcp/tools.json` was captured by `tools/list` against the 0.6.0 source server on September 24, 2026. It is a reference snapshot of that version, not a promise that every installed release exposes the same tools. Example project IDs in descriptions are normalized to HBR/ADR. No published OpenAPI specification exists; the HTTP page identifies its routes as a small subset of the local UI implementation.

The current Home and Board screenshots use a synthetic Harbor fixture and the current development UI. The fixture has an authored re-entry note and a short project introduction. Only JPEG compression was applied to native screenshots. Historical scripted demo evidence and replay instructions remain in `site/demo/`. Its original completed-epic image is historical run evidence, not a current UI showcase. The homepage and README use `current-home.jpg`.
The five older `product-*.jpg` and `gitdocket-home.png` assets are no longer used by current pages or the public export. Historical Docket receipts retain their original paths and observed statuses as past evidence; their bytes remain recoverable from public Git commit `d40a888`. The old paths are not current live-link guarantees. `gitdocket-home.png` also held JPEG bytes under a PNG name.

Before production deployment, preview the exact public commit. Verify all HTML pages, stylesheet, favicon, current images, schema download and demo links return 200. Check desktop and narrow layouts, keyboard navigation, the expandable Board, and the browser console. Confirm no third-party requests from the authored site. Preserve explicit preview availability and the distinction between record excerpts and fresh test execution. Website-only edits after a release do not change the immutable tag, npm packages or standalone archives.

Add public files to `release/public-export.json`. Validate an exact committed snapshot from a clean source checkout with `bun run export-public`; a dirty development checkout is intentionally rejected.

Cloudflare Pages deploys the `main` branch to `gitdocket.com`. After each website change, confirm HTTPS, the canonical domain, current installation wording and the affected pages. Package publication and production site deployment remain separately authorized actions.
