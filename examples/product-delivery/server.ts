import { join } from "node:path";

const files = new Set([
  "index.html",
  "app.js",
  "bookmarks.js",
  "fixtures.js",
  "style.css",
]);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 4173),
  fetch(request) {
    const name = new URL(request.url).pathname.slice(1) || "index.html";
    if (!files.has(name)) return new Response("Not found", { status: 404 });
    return new Response(Bun.file(join(import.meta.dir, "app", name)));
  },
});
console.log(`Beacon is running at ${server.url}`);
