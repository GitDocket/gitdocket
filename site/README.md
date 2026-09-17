# Website deployment

The site is static: no package install, build step, server runtime, analytics, cookies, scripts, or third-party requests.

For Cloudflare Pages:

- Production branch: `main`
- Framework preset: None
- Build command: leave blank
- Build output directory: `site`
- Root directory: repository root

The homepage keeps the pitch, current product UI, a short workflow, workflow-extension value and the OKF v0.1 foundation. The Board screenshot expands on demand. The beginner path still starts with one task. Keep setup aligned with `docs/getting-started.md`; verify CLI examples against command help and MCP schemas against a real `tools/list` response.

The extension reading path is `/docs/extensions/` → `/docs/extensions/beacon/` → `/docs/extensions/reference/`. The overview explains the benefit; Beacon shows actual excerpted delivery records and versioned installation setup; the reference renders `docs/extensions.md` with its Beacon links mapped to the site walkthrough. Keep the reference in sync with that Markdown source. `site/demo/product-delivery/` retains verbatim qualified artifact excerpts, source hashes, assistance and limits. Do not turn supplied test review into observed human approval, or the assisted browser check into an unattended run.

This source contains the prepared 0.4.0 launch content: Homebrew supplies both commands, npm is the Node-based alternative, and workflow extensions are included. Keep the current public main and deployed site unchanged until the authorized release/tap publication and four-platform public-installation workflow pass. Then fast-forward the reviewed public commit and perform the authorized site cutover. The example app still requires Bun independently of GitDocket. Rebuild its source archive with `bun scripts/extensions/package-examples.ts` after changing docs/examples, then independently extract and verify the manifest and prepared-project links. Preparation does not authorize publication.

`site/docs/mcp/tools.json` was captured from the locally packed candidate on September 14, 2026 for 0.4.0. It is a reference snapshot, not a promise that all installed versions expose the same tools. Example project IDs in descriptions are normalized to HBR/ADR. No published OpenAPI specification exists; the HTTP page identifies its routes as a small subset of the local UI implementation.

The current Home and Board screenshots use a synthetic Harbor fixture and the current development UI. The fixture has an authored re-entry note and a short project introduction. Only JPEG compression was applied to native screenshots. Historical scripted demo evidence and replay instructions remain in `site/demo/`. Its original completed-epic image is historical run evidence, not a current UI showcase. The homepage and README use `current-home.jpg`.

Before production deployment, preview the exact public commit. Verify all HTML pages, stylesheet, favicon, current images, schema download and demo links return 200. Check desktop and narrow layouts, keyboard navigation, the expandable Board, and the browser console. Confirm no third-party page requests. Preserve explicit preview availability and the distinction between record excerpts and fresh test execution.

Add public files to `release/public-export.json`. Validate an exact committed snapshot from a clean source checkout with `bun run export-public`; a dirty development checkout is intentionally rejected.

The owner completes the Cloudflare account/repository connection, authorizes production deployment, and configures the custom domain. After DNS is active, confirm certificate issuance, HTTPS, and canonical domain redirects. Package publication and production site deployment remain separately authorized actions.
