import { expect, test } from "bun:test";
import { checkMermaidSource } from "./mermaid-source";

test("diagram source cannot override host configuration or load external assets", () => {
  for (const source of [
    '%%{init: {"securityLevel":"loose"}}%%\nflowchart LR\n A-->B',
    "---\nconfig:\n securityLevel: loose\n---\nflowchart LR\n A-->B",
    'flowchart LR\n A@{ img: "https://example.com/image.svg" }',
    "flowchart LR\n style A fill:url(https://example.com/image.svg)",
    'flowchart LR\n classDef default css:@import "https://example.com/a.css"',
    String.raw`flowchart LR
 style A fill:u\72l(https://example.com/image.svg)`,
    "flowchart LR\n style A fill:u/**/rl(https://example.com/image.svg)",
    String.raw`flowchart LR
 A@{ "\69mg": "https://example.com/image.svg" }`,
    "x".repeat(50_001),
  ])
    expect(() => checkMermaidSource(source)).toThrow();
  for (const source of [
    "flowchart LR\n A[Start] --> B[Finish]",
    "sequenceDiagram\n Alice->>Bob: Hello",
    "stateDiagram-v2\n [*] --> Ready",
    "flowchart LR\n A---B",
  ])
    expect(() => checkMermaidSource(source)).not.toThrow();
});
