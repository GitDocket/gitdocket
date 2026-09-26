# Beacon: request to local release handoff

Beacon is a small, working bookmark app before JSON export exists. The installable `product-delivery` package supplies the review, delivery and knowledge-reuse process; `incident-review` demonstrates a second independently owned workflow. The recorded qualification installed both through an actual GitDocket 0.4.0 development candidate; current readers can use the released 0.6.0 commands below. This is a synthetic learning and qualification example, not a released app or prewritten successful agent demonstration.

## What you will learn

Follow one request through a reviewed proposal, an implemented and verified export feature, and a local handoff. Then open a fresh session and ask it to plan import: the recorded export decision gives that session a concrete starting point. You can change the reviewer and checks for your team without changing GitDocket itself.

The agent follows the process; you review and authorize the next step. GitDocket manages the installed package and ordinary task records. Installing the workflow does not start implementation or approve a proposal.

## 1. Prepare the starting project

Install GitDocket 0.6.0 with `brew install gitdocket/tap/gitdocket`, or use the [npm alternative](https://github.com/GitDocket/gitdocket/blob/main/docs/npm.md). This example app and its verification scripts additionally need Bun 1.3.14+, Git and a coding agent. Full delivery verification needs Chrome/Chromium and permission to run a local server. The source archive does not include the CLI. Bun is an example-app prerequisite; the installed GitDocket commands do not need a separate Bun runtime.

From an extracted example download or GitDocket source checkout, prepare a previously nonexistent disposable repository:

```sh
bun scripts/extensions/prepare-example.ts --dest=/absolute/new/beacon --cli=/absolute/installed/docket
cd /absolute/new/beacon
bun run docket -- extension show product-delivery --json
bun run docket -- extension configure product-delivery --set '{"reviewer":"release owner"}' --json
bun run docket -- extension show product-delivery --json
```

Replace the absolute paths with your installed GitDocket executable and a new destination. The helper initializes a Git project and installs/enables the canonical packages through that executable. The second `show` should report `release owner` as the effective reviewer with project ownership. To view the starting app, run `bun run start`, open `http://127.0.0.1:4173`, then stop that server before browser verification.

Use the exact installed candidate executable, not a source fallback. `example-source.json` records its version, canonical package source hashes, installation/configuration state and setup commands. The generated wrapper continues to require that installed CLI path. Both registry and installed content are committed, and the repository needs no author package directory after preparation. Read [the extension author/adopter guide](../../docs/extensions.md) for installation into an existing project, updating, reconciliation and retirement.

## 2. Ask for a proposal

The current canonical workflow is [product-delivery:deliver](../extensions/product-delivery/workflows/delivery.md); templates, scoped guidance, tool recipes and [qualification scenarios](../extensions/product-delivery/scenarios/beacon.md) live in that same package. Open the prepared repository in a fresh agent and ask: “Use product-delivery:deliver to prepare a proposal for Beacon issue BEC-42. Bring it back for review before planning implementation.” BEC-42 is supplied synthetic issue text already retained at `docket/requests/BEC-42.md`; the default example needs no issue-tracker connection. Preparation creates no implementation task, review input, agent response or export feature.

## 3. Review, deliver and verify

Read the actual proposal and retain its exact hash or commit. The next step belongs to the configured `release owner`: accept that revision, request changes, or reject it. In a test run, label a supplied review as synthetic and identify who supplied it; a role name alone is not approval. Acceptance must also state whether planning or implementation is authorized. Authorize creation of an epic/tasks explicitly if you want the demonstrated tracked plan. A changed proposal needs fresh review.

The agent implements the accepted export, runs baseline, contract and browser checks, and records the results. A failed or unavailable required check leaves delivery unresolved. Only successful verification supports a local release-review handoff. Preserve actual actions, task-linked commits, decisions and failed as well as passing check output. Try unanswered and rejected reviews in separate copies: neither should create implementation work or change the app. Fresh sessions resume from retained evidence rather than repeating completed work.

## 4. Use the decision in the next session

After a verified local handoff, open a fresh session in the same repository and ask: “Plan support for importing a previously exported Beacon bookmark file.” The response should find and cite the recorded export contract, then identify new import decisions such as validation and replacement behavior that need review. This prompt authorizes a plan only; it should create no tasks or implementation.

## Optional connected tools

The handoff stays local. Optional recipes use host-provided issue/check/post tools; absent or ambiguous capabilities are explicit. `scripts/extensions/prepare-tool-case.ts` and `mcp-fixture.ts` reproduce local synthetic issue/check/handoff success, failure and uncertainty. For the canonical packaged process, invoke preparation with `--package=product-delivery --cli-source=/absolute/installed/docket`; the helper defaults otherwise select the historical tool-rehearsal package and source CLI. Use `--base=/absolute/verified/beacon --dest=/absolute/new/tool-case --mode=uncertain` (or the documented success/failure/read modes), then the generated prompt and fixture path with `run-agent-case.ts`. They never contact a live destination. Actual native observations, scripted setup, supplied reviews and unsupported hosts must be recorded separately. The historical manual fixture sources and `prepare-rehearsal.ts` remain for baseline reproduction; `prepare-example.ts` installs only the canonical packaged process and does not copy the earlier manual workflow or templates.

## Application interface

`bun run start` serves `app/` at `http://127.0.0.1:4173`; set `PORT` to choose another port. The app renders saved titles, URL text and tags, adds records with the form and removes individual records. It stores JSON arrays in localStorage under `beacon.bookmarks.v1`. With no saved key it shows the public-safe records in `app/fixtures.js`; a stored `[]` means an empty library. URLs are display text and are never fetched by normal bookmark actions.

The following small interface is fixed for the rehearsal so independent checks can exercise later agent changes:

- `app/bookmarks.js` exports `STORAGE_KEY`, `readBookmarks(storage)` and `writeBookmarks(storage, records)`. The future implementation adds `serializeBookmarks(records)`, returning the JSON string used by the download. It must preserve records and leave input unchanged.
- `app/fixtures.js` exports `bookmarkFixtures`, containing the ordinary and Unicode examples. Keep fixture inputs and the supplied acceptance checks unchanged during implementation.
- Once rendering is ready, `document.documentElement.dataset.beaconReady` is `"true"`. Each saved record is one `#bookmarks [data-bookmark]` element. The add form is `#add-bookmark`, with fields named `title`, `url` and `tags`; its submit button saves a record. Each record has a Remove button.
- The accepted implementation adds a visible, enabled `<button data-action="export">` that downloads the current saved collection, including an empty one. The checker clicks that actual button through Chromium input events. No export button or serializer exists in the baseline.
- Export JSON is exactly `{ "schemaVersion": 1, "bookmarks": [...] }`. Each bookmark retains its `title`, `url` and `tags`. The downloaded file uses a `.json` filename. Tests require the browser's completed download bytes to parse to the expected object; creating a Blob or calling a helper alone is insufficient.

## Checks and evidence

```sh
bun run test:baseline
bun run test
bun run test:browser -- --chrome=/path/to/chromium --output=/tmp/beacon-browser.json
```

`test:baseline` passes on the initial fixture and checks local storage behavior. `test` deliberately exits 1 on the baseline for the missing serializer. `test:browser` first verifies rendering, add, persistence and removal in real Chromium, then fails because the baseline has no export button. After implementation, both export checks must pass. The acceptance script is named `.acceptance.ts` so a normal GitDocket `bun test` run does not mistake the intentional red fixture for a repository regression.

The browser checker is retained at `scripts/extensions/check-beacon-browser.ts` in GitDocket and copied to `scripts/check-beacon-browser.ts` in each rehearsal. It accepts `--root=<fixture repo>`, `--chrome=<executable>`, `--output=<JSON receipt>` and `--observation-ms=<milliseconds>` (default 1000, minimum 500). `CHROME_PATH` is an alternative to `--chrome`; common macOS and Linux locations are searched. A missing browser produces `unsupported` and a nonzero exit, never a pass. It launches its own disposable profile and loopback server, leaving existing browser sessions alone.

For populated and empty collections separately, the checker sets localStorage, reloads, captures the button's bounds and dispatches a real mouse click. Browser download events establish completion; the file is read from the temporary download directory, parsed and compared to the fixture. CDP request events collect all page request attempts after the action, including failures and WebSockets. The checker rejects network-backed download URLs and observes until at least one second after the click and through download completion by default. It also records local-server requests to corroborate the page events. Blob and data download URLs are local artifacts, not network traffic. The reported observation duration and scope bound the claim: this does not prove the absence of arbitrary requests scheduled after observation or browser-internal background traffic.

The JSON receipt includes pass/fail/unsupported, browser version, actual input/output and request observations, app file hashes, Git revision and working diff hash. A failed check leaves delivery unresolved regardless of task status. Keep verification-only reference implementations and seeded defects in separate disposable copies; do not bake a passing implementation into this starting fixture.
