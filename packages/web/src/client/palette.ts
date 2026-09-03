// Pure item logic for the command palette: the view catalog and how
// a typed query merges navigation targets with core's ranked concept hits
// into one result list. The overlay component stays thin.

export interface ViewItem {
  kind: "view";
  label: string;
  hash: string;
}

export interface ConceptItem {
  kind: "concept";
  path: string;
  id?: string;
  title?: string;
  text: string;
}

export type PaletteItem = ViewItem | ConceptItem;

export interface SearchHit {
  path: string;
  line: number;
  text: string;
  id?: string;
  title?: string;
}

/** Fixed views first, then one entry per docs directory. */
export function viewCatalog(sections: string[]): ViewItem[] {
  const view = (label: string, hash: string): ViewItem => ({
    kind: "view",
    label,
    hash,
  });
  return [
    view("Home", "#/"),
    view("Wiki", "#/wiki"),
    view("Tasks", "#/tasks"),
    view("Board", "#/board"),
    view("Epics", "#/epics"),
    view("Activity", "#/activity"),
    view("Docs", "#/docs"),
    ...sections.map((s) => view(`Docs: ${s}`, `#/docs/${s}`)),
  ];
}

/**
 * One list per query: empty query is browse mode (the whole catalog);
 * otherwise substring-matched views lead — few and exact — and the engine's
 * ranked hits follow in their given order, ranking untouched.
 */
export function paletteItems(
  views: ViewItem[],
  hits: SearchHit[],
  q: string,
): PaletteItem[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return views;
  return [
    ...views.filter((v) => v.label.toLowerCase().includes(needle)),
    ...hits.map(
      (h): ConceptItem => ({
        kind: "concept",
        path: h.path,
        id: h.id,
        title: h.title,
        text: h.text,
      }),
    ),
  ];
}

export const itemHash = (item: PaletteItem): string =>
  item.kind === "view" ? item.hash : `#/c/${item.path}`;
