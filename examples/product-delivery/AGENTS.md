## Beacon project context

Before acting, read `docket/reference/project-guidance.md` and follow its relevant links. The explicitly invokable **Product delivery** workflow is `docket/workflows/product-delivery.md`: prepare a feature proposal, wait for the required review, implement accepted scope through existing Docket operations, verify the application and prepare a local release handoff. Its templates are linked from that source. This is a manually copied portable Markdown workflow, with no extension API or native discovery claim.

Use `bun run docket -- <arguments>` for this rehearsal's current-source Docket CLI. `rehearsal-source.json` identifies the source checkout and hashes used by preparation. Read `README.md` for the app interface and checks. Acceptance checks deliberately fail in the initial fixture because export has not been implemented; a later agent must implement the accepted feature rather than weakening the checks.

Keep Markdown paragraphs and simple list items on single source lines. Application code, acceptance checks, recorded evidence and generated Docket files have distinct roles; retain the actual source and output behind each result. Never present a supplied review input or a template as an observed human action or completed agent response.
