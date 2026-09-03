// Pure logic for the Docs view: sidebar ordering and telling doc
// paths apart from work items so concept pages pick the right layout.

export interface DocItem {
  path: string;
  title: string | null;
  description: string | null;
}

export interface DocSection {
  name: string;
  items: DocItem[];
}

// The server lists articles newest-first — right for "what changed"
// listings, wrong for a navigation rail. The sidebar re-sorts each section
// alphabetically by title so an article keeps its place between visits.
export function sidebarSections(sections: DocSection[]): DocSection[] {
  return sections.map((section) => ({
    name: section.name,
    items: [...section.items].sort((a, z) =>
      (a.title ?? a.path).localeCompare(z.title ?? z.path, undefined, {
        sensitivity: "base",
      }),
    ),
  }));
}

/** True when the path lives in a docs section — work items and root files don't. */
export const isDocPath = (path: string, sections: string[]): boolean =>
  sections.includes(path.split("/")[0] ?? "");
