// Resolve the SDK from the workspace that declares it, including isolated
// installs. Benchmark scripts must not depend on incidental root hoisting.
export { Client } from "@modelcontextprotocol/sdk/client/index.js";
export { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
export { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
