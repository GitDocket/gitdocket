import type { ListItem, Paragraph } from "mdast";
import { useId, useState } from "react";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { conceptHref } from "../urls";
import type { SearchHit } from "./palette";

/** Source spans let retirement remove exactly the chosen authored block. */
export function guidanceEntries(body: string) {
  const root = unified().use(remarkParse).parse(body);
  return root.children
    .flatMap<ListItem | Paragraph>((node) =>
      node.type === "list"
        ? node.children
        : node.type === "paragraph"
          ? [node]
          : [],
    )
    .flatMap((node) => {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      return start === undefined || end === undefined
        ? []
        : [{ start, end, text: body.slice(start, end) }];
    });
}
const append = (body: string, entry: string) =>
  `${body.trimEnd()}\n\n${entry}\n`;
export function appendActiveGuidance(body: string, entry: string) {
  const updated = append(body, `# Active guidance\n\n${entry}`);
  const headingOffset = body.trimEnd().length + 2;
  const root = unified().use(remarkParse).parse(updated);
  if (
    !root.children.some(
      (node) =>
        node.type === "heading" &&
        node.depth === 1 &&
        node.position?.start.offset === headingOffset,
    )
  )
    throw new Error(
      "Close the final Markdown code fence or HTML block in Content before adding active guidance.",
    );
  return updated;
}
export const procedureDestination = (path: string) =>
  `/${path
    .split("/")
    .map((part) =>
      encodeURIComponent(part).replace(/[()]/g, (character) =>
        character === "(" ? "%28" : "%29",
      ),
    )
    .join("/")}`;
const plain = (value: string) => value.trim().replace(/\s+/g, " ");
const escapeLabel = (value: string) => plain(value).replace(/[\\[\]]/g, "\\$&");

export function GuidanceTools({
  body,
  changeBody,
}: {
  body: string;
  changeBody: (body: string) => void;
}) {
  const id = useId();
  const [instruction, setInstruction] = useState("");
  const [scope, setScope] = useState("");
  const [kind, setKind] = useState("Requirement");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState("");
  const [searching, setSearching] = useState(false);
  const [reason, setReason] = useState("");
  const [selected, setSelected] = useState("");
  const entries = guidanceEntries(body);
  const entry = entries.find(
    (item) => `${item.start}:${item.end}:${item.text}` === selected,
  );
  const scoped = scope.trim()
    ? `Scope: ${plain(scope)}.`
    : "Scope: project-wide.";
  const add = (entry: string) => {
    try {
      changeBody(appendActiveGuidance(body, entry));
      setError("");
      return true;
    } catch (error) {
      setError(String(error));
      return false;
    }
  };
  const search = async () => {
    setSearching(true);
    setError("");
    try {
      const response = await fetch(
        `/api/search?q=${encodeURIComponent(query)}&limit=50&page=1`,
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Search failed.");
      setHits(
        data.hits.filter(
          (hit: SearchHit) =>
            hit.path !== "reference/project-guidance.md" &&
            ["Reference", "Playbook", "Workflow"].includes(hit.type ?? ""),
        ),
      );
      setSearched(true);
    } catch (error) {
      setError(String(error));
    } finally {
      setSearching(false);
    }
  };
  return (
    <details className="guidance-tools" open>
      <summary>Manage guidance in this draft</summary>
      {error && <p role="alert">{error}</p>}
      <p>
        These controls update the Markdown below. Review the draft, then Save.
        Edit existing wording and scope directly in Content.
      </p>
      <label htmlFor={`${id}-scope`}>Scope for the new entry</label>
      <input
        id={`${id}-scope`}
        value={scope}
        onChange={(event) => setScope(event.target.value)}
        placeholder="Project-wide, or describe files and situations"
      />
      <div className="guidance-tools-grid">
        <section aria-label="Add instruction">
          <h3>Add instruction</h3>
          <label htmlFor={`${id}-kind`}>Strength</label>
          <select
            id={`${id}-kind`}
            value={kind}
            onChange={(event) => setKind(event.target.value)}
          >
            <option>Requirement</option>
            <option>Preference</option>
          </select>
          <label htmlFor={`${id}-instruction`}>Instruction</label>
          <textarea
            id={`${id}-instruction`}
            rows={3}
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
          />
          <button
            type="button"
            disabled={!instruction.trim()}
            onClick={() => {
              if (add(`- ${kind}: ${plain(instruction)} ${scoped}`))
                setInstruction("");
            }}
          >
            Add instruction to draft
          </button>
        </section>
        <section aria-label="Link existing procedure">
          <h3>Link existing procedure</h3>
          <label htmlFor={`${id}-search`}>Search existing documents</label>
          <input
            id={`${id}-search`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            type="button"
            disabled={searching || !query.trim()}
            onClick={() => void search()}
          >
            Find procedure
          </button>
          {searched && (
            <p className="muted">
              Matching references, playbooks and workflows from the first 50
              search results. Refine your search if needed.
            </p>
          )}
          <ul>
            {hits.map((hit) => (
              <li key={hit.path}>
                <a href={conceptHref(hit)}>{hit.title ?? hit.path}</a>{" "}
                <button
                  type="button"
                  onClick={() =>
                    add(
                      `- Procedure: [${escapeLabel(hit.title ?? hit.path)}](${procedureDestination(hit.path)}). ${scoped} Read this source when applicable; linking it does not authorize execution.`,
                    )
                  }
                >
                  Link to draft
                </button>
              </li>
            ))}
          </ul>
          {searched && !hits.length && (
            <p>No matching procedure sources. Try their title or path.</p>
          )}
        </section>
      </div>
      <details>
        <summary>Remove from active guidance</summary>
        <p>
          Remove a whole paragraph or list item from this source. Linked
          documents stay in place. For part of an entry, edit Content directly.
        </p>
        <label htmlFor={`${id}-entry`}>Entry to remove</label>
        <select
          id={`${id}-entry`}
          value={entry ? selected : ""}
          onChange={(event) => setSelected(event.target.value)}
        >
          <option value="">Choose an entry</option>
          {entries.map((item) => (
            <option
              key={item.start}
              value={`${item.start}:${item.end}:${item.text}`}
            >
              {item.text.slice(0, 180)}
            </option>
          ))}
        </select>
        <label htmlFor={`${id}-reason`}>Reason for removal</label>
        <input
          id={`${id}-reason`}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <button
          type="button"
          disabled={!entry || !reason.trim()}
          onClick={() => {
            if (!entry) return;
            changeBody(
              append(
                body.slice(0, entry.start) + body.slice(entry.end),
                `<!-- Retired guidance entry: ${plain(reason).replace(/--/g, "—").replace(/>/g, "")} -->`,
              ),
            );
            setSelected("");
            setReason("");
          }}
        >
          Remove entry from draft
        </button>
      </details>
    </details>
  );
}
