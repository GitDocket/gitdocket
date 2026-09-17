# Workflow packages

`minimal/` is the smallest complete v1 content package. It contributes one review-only workflow, `tiny:review`, and a project-owned reviewer choice. It contains no application, installation script, MCP server or executable check. Its exact package digest is the contract test vector in [package-digest-vector.json](package-digest-vector.json); the real CLI integration tests install these same files.

With the 0.4.0 development CLI available in an initialized disposable Docket project, inspect and adopt the directory:

```sh
docket extension inspect /absolute/gitdocket-checkout/examples/extensions/minimal --json
docket extension install /absolute/gitdocket-checkout/examples/extensions/minimal
docket extension enable tiny
docket extension configure tiny --set '{"reviewer":"release owner"}'
docket extension show tiny
```

Install is disabled by default. `--enable` requests immediate compatible availability; `--dry-run` reports changes without writing. Commit the bundle's `extensions/registry.json` and `extensions/tiny/` together so another checkout has the exact source, original base and project choices. The original package directory is unnecessary after installation.

```sh
docket extension configure tiny --reset reviewer
docket extension disable tiny
docket extension remove tiny
docket extension show tiny --json
```

Removal retires availability and preserves the content, choices and source links. Explicit `enable tiny` reinstates retained compatible content. These commands neither create/start work nor execute the review. For current discovery, updates, reconciliation, capabilities and complete examples, use [the author/adopter guide](../../docs/extensions.md).

The `beacon-tools` package is the local MCP integration rehearsal for Beacon's issue/check/prepared-handoff stages. Its recipes use conceptual capabilities; the qualification harness supplies bindings to an explicitly launched synthetic server. It is separate from the complete product-delivery author/adopter package. The repository's integration qualification reference retains the actual native and protocol evidence and does not claim live-provider support.

The canonical [product-delivery](product-delivery/workflows/delivery.md) package and independent [incident-review](incident-review/workflows/review.md) package install together. [Prepare Beacon](../product-delivery/README.md) through the installed candidate to exercise review branches, verification, local handoff and later knowledge reuse. Their manifests, scenario sources and public download share the same files.
