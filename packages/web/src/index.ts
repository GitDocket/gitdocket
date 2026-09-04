// @gitdocket/web — the renderer surface: Hono API over core + React SPA.

export { type Assets, createApp } from "./app";
export { renderMarkdown } from "./render";
export { buildAssets, type ServeOptions, startServe } from "./serve";
export { createRepoContext, type RepoContext, type RepoState } from "./state";
