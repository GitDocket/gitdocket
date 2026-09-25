import mermaid from "mermaid";
import { checkMermaidSource } from "./mermaid-source";

// Mermaid configuration is global. Serialize initialization and rendering across
// every reading/preview surface, including a theme change during an earlier draw.
let queue: Promise<unknown> = Promise.resolve();
let sequence = 0;
export function renderDiagram(
  source: string,
  dark: boolean,
  current: () => boolean,
) {
  const result = queue.then(async () => {
    if (!current()) return undefined;
    checkMermaidSource(source);
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: dark ? "dark" : "default",
      fontFamily: "system-ui, sans-serif",
      htmlLabels: false,
      layout: "dagre",
      maxTextSize: 50_000,
      maxEdges: 500,
      // Protect host policy even if upstream adds another configuration syntax.
      secure: [
        "securityLevel",
        "startOnLoad",
        "suppressErrorRendering",
        "maxTextSize",
        "maxEdges",
        "htmlLabels",
        "fontFamily",
        "theme",
        "layout",
        "secure",
      ],
    });
    const staging = document.createElement("div");
    staging.className = "mermaid-staging";
    staging.setAttribute("aria-hidden", "true");
    document.body.append(staging);
    try {
      const { svg } = await mermaid.render(
        `docket-mermaid-${++sequence}`,
        source,
        staging,
      );
      return current() ? svg : undefined;
    } finally {
      staging.remove();
    }
  });
  queue = result.catch(() => {});
  return result;
}
