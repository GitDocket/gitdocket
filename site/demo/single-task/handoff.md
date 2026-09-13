# Fresh-session handoff

Method: a separate agent context with no implementation conversation inspected a clean clone at `d1f601f`. The parent supplied the fixture directory, instruction to read its generated AGENTS.md, candidate CLI path, unchanged request and evidence-recording directions. No project decision or writing convention was supplied in the request. This is an agent proxy with disclosed discovery assistance, not native-host auto-discovery or customer research. Below is the actual response; local file links are normalized to the adjacent retained source snapshots for publication.

## Request

> Where did we leave off? Using repository evidence, explain how we should add a troubleshooting guide and make it discoverable. Cite the project decision that affects your recommendation, and apply any relevant saved project guidance. This is a read-only planning request; do not create or start work.

## Response

We left off with **HBR-1, “Add a contributor guide,” completed**. The guide and README entry point were added, and the recorded checks covered headings and relative links. The overview shows no work in flight or queued next. [Completed task](task.md)

For the troubleshooting guide:

1. Add a Markdown reference concept at a proposed path such as `docket/reference/troubleshooting.md`, beside the contributor guide.
2. Organize it around known problems, with symptoms, numbered diagnostic steps, corrective actions, and a way to verify recovery. Use short imperative sentences and explain steps when context is needed, applying the saved guidance for contributor-facing documentation. [Project guidance](project-guidance.md)
3. Link it from README for discovery. Add a contextual link from the contributor guide where troubleshooting would help contributors.
4. Keep the instructions usable offline and use repository-relative Markdown links. This follows the project’s **Offline documentation** decision, which also specifies placing new guides beside the contributor guide and linking them from README. [Documentation decision](documentation.md)
5. Verify every relative link target exists and record the checks performed, following the existing contributor review instructions. [Contributor guide](contributing.md)

This is a proposed plan; no work was created or started.

## Evidence reported by the reader

- Read `AGENTS.md`, `README.md`, `docket/work/tasks/HBR-1-add-a-contributor-guide.md`, `docket/reference/contributing.md`, and `docket/reference/documentation.md`.
- Ran the candidate source CLI's `overview --json` and `guidance --json` in the fresh clone. Guidance returned the complete eight-line source with no continuation links or diagnostics.
- Ran `git status --short`; output was empty.
- Assistance: used the candidate CLI path supplied in the assignment. No additional agent assistance, execution errors, parent repository documentation, or task history was used.
- Changed tracked files: **none**.

The parent inspected the resulting plan against the retained source: step 4 applies the decision learned during the completed task; step 2 applies the later browser-saved instruction. No correction or coached recheck was needed. Recognizing completion alone was not the success criterion. The reader did not implement the proposed guide, and no new task was created.
