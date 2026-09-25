import { useEffect, useMemo, useRef, useState } from "react";
import { checkMermaidSource } from "./mermaid-source";

/** The only HTML input is the server's safe Markdown renderer. */
export function Markdown({
  html,
  preview = false,
}: {
  html: string;
  preview?: boolean;
}) {
  const root = useRef<HTMLElement>(null);
  // Keep React from replacing hydrated diagrams on unrelated parent updates.
  const markup = useMemo(() => ({ __html: html }), [html]);
  const [dark, setDark] = useState(() =>
    typeof matchMedia === "function"
      ? matchMedia("(prefers-color-scheme: dark)").matches
      : false,
  );
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const change = () => setDark(media.matches);
    media.addEventListener("change", change);
    change();
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    // Restore original fences on theme changes; never reparse generated SVG.
    element.innerHTML = html;
    let disposed = false;
    const current = () => !disposed;
    for (const code of element.querySelectorAll(
      "pre > code.language-mermaid",
    )) {
      const pre = code.parentElement;
      if (!pre) continue;
      const source = code.textContent ?? "";
      const figure = document.createElement("figure");
      figure.className = "mermaid-diagram";
      const output = document.createElement("div");
      output.className = "mermaid-output";
      const status = document.createElement("p");
      status.className = "muted";
      status.setAttribute("role", "status");
      status.textContent = "Loading diagram…";
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "Diagram source";
      pre.replaceWith(figure);
      details.append(summary, pre);
      figure.append(status, output, details);
      const fail = (error: unknown) => {
        if (!current()) return;
        status.textContent = `Unable to display diagram: ${error instanceof Error ? error.message : "Rendering failed."}`;
        details.open = true;
      };
      try {
        checkMermaidSource(source);
        void import("./mermaid-render")
          .then(({ renderDiagram }) => renderDiagram(source, dark, current))
          .then((svg) => {
            if (!current() || svg === undefined) return;
            // Mermaid sanitizes SVG in strict mode; never bind document callbacks.
            output.innerHTML = svg;
            const diagram = output.querySelector("svg");
            if (diagram) {
              const { width, height } = diagram.viewBox.baseVal;
              if (width && height) {
                diagram.setAttribute("width", String(width));
                diagram.setAttribute("height", String(height));
                diagram.style.maxWidth = "none";
              }
            }
            if (diagram && !diagram.hasAttribute("aria-labelledby")) {
              diagram.setAttribute("role", "img");
              diagram.setAttribute(
                "aria-label",
                "Mermaid diagram; text definition available in Diagram source",
              );
            }
            status.remove();
          })
          .catch(fail);
      } catch (error) {
        fail(error);
      }
    }
    return () => {
      disposed = true;
    };
  }, [html, dark]);
  const Tag = preview ? "section" : "article";
  return (
    <Tag
      ref={root}
      className={preview ? "md editor-preview" : "md"}
      aria-label={preview ? "Markdown preview" : undefined}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: server uses the shared safe Markdown renderer.
      dangerouslySetInnerHTML={markup}
    />
  );
}
