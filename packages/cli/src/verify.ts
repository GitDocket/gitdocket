// Compatibility entry point for the CLI tests and command wiring. Repo IO is
// shared with serve at the cache boundary so both surfaces derive identical
// verification rows.
export { scanRepoMarkers } from "@gitdocket/core/cache";
