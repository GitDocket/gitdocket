import type { ReactNode } from "react";

// A small, consistent stroke icon set. Fixed SVG boxes keep navigation anchors
// independent of label visibility and sidebar width.
const paths: Record<string, ReactNode> = {
  Wiki: (
    <>
      <path d="M12 5C8 2 3 3 3 3v16s5-1 9 2c4-3 9-2 9-2V3s-5-1-9 2Z" />
      <path d="M12 5v16" />
    </>
  ),
  Board: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M9 3v18M15 3v18M5 7h2m4 4h2m4-4h2" />
    </>
  ),
  Home: (
    <>
      <path d="m3 10 9-7 9 7v11h-7v-7h-4v7H3Z" />
    </>
  ),
  Tasks: (
    <>
      <path d="m3 6 2 2 3-4m-5 9 2 2 3-4m-5 9 2 2 3-4M12 6h9M12 13h9M12 20h9" />
    </>
  ),
  Epics: (
    <>
      <path d="m12 3 9 5-9 5-9-5Zm-9 9 9 5 9-5m-18 5 9 5 9-5" />
    </>
  ),
  "Project guidance": (
    <>
      <path d="M5 3h14v18H5Z" />
      <path d="m8 9 2 2 5-5M8 15h8M8 18h6" />
    </>
  ),
  Activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  Search: (
    <>
      <circle cx="10" cy="10" r="6" />
      <path d="m15 15 6 6" />
    </>
  ),
  Collapse: <path d="m15 3-7 9 7 9" />,
  Expand: <path d="m9 3 7 9-7 9" />,
  Refresh: (
    <>
      <path d="M20 7a9 9 0 1 0 1 8M20 2v6h-6" />
    </>
  ),
};
export function Icon({ name }: { name: string }) {
  return (
    <svg
      className="workspace-icon"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
export function readPreference(key: string, fallback = "") {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
export function writePreference(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Storage may be disabled. */
  }
}
export function rememberedView(view: string) {
  try {
    return sessionStorage.getItem(`docket.view.${view}`) ?? `#/${view}`;
  } catch {
    return `#/${view}`;
  }
}
export function rememberView(view: string, hash: string) {
  try {
    sessionStorage.setItem(`docket.view.${view}`, hash);
  } catch {
    /* Optional return context. */
  }
}
