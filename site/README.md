# Website deployment

The site is static: no package install, build step, server runtime, analytics,
cookies, scripts, or third-party requests.

For Cloudflare Pages:

- Production branch: `main`
- Framework preset: None
- Build command: leave blank
- Build output directory: `site`
- Root directory: repository root

The homepage keeps the pitch, current product UI, a short workflow, and the
OKF v0.1 foundation. The Board screenshot expands on demand. Reference content
lives on the site at `/docs/`, `/docs/cli/`, `/docs/mcp/`, and `/docs/api/`.
Keep setup aligned with `docs/getting-started.md`; verify CLI examples against
command help and MCP schemas against a real `tools/list` response.

`site/docs/mcp/tools.json` was captured from the development server on
2026-09-13 for 0.3.0. It is a reference snapshot, not a promise that all installed
versions expose the same tools. Example project IDs in descriptions are
normalized to HBR/ADR. No published OpenAPI specification exists; the HTTP page
identifies its routes as a small subset of the local UI implementation.

The current Home and Board screenshots use a synthetic Harbor fixture and the
current development UI. The fixture has an authored re-entry note and a short
project introduction. Only JPEG compression was applied to native screenshots.
Historical scripted demo evidence and replay instructions remain in `site/demo/`.
Its original completed-epic image is historical run evidence, not a current UI
showcase. The homepage and README use `current-home.jpg`.

Before production deployment, preview the exact public commit. Verify all eight
HTML pages, stylesheet, favicon, current images, schema download, and demo links
return 200. Check desktop and narrow layouts, keyboard navigation, the expandable
Board, and the browser console. Confirm no third-party network requests.

Add public files to `release/public-export.json`. Validate an exact committed
snapshot from a clean source checkout with `bun run export-public`; a dirty
development checkout is intentionally rejected.

The owner completes the Cloudflare account/repository connection, authorizes
production deployment, and configures the custom domain. After DNS is active,
confirm certificate issuance, HTTPS, and canonical domain redirects. Package
publication and production site deployment remain separately authorized actions.
