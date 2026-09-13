/** Work items share the configured project's numeric sequence. */
export const isTicketNumber = (value: string): boolean =>
  /^[1-9]\d*$/.test(value);

/** Called only with work-item identity, never inferred from a filename. */
export function workHref(item: { id: string }): string {
  const number = /-([1-9]\d*)$/.exec(item.id)?.[1];
  return `#/work/${number ?? encodeURIComponent(item.id)}`;
}

export function conceptHref(item: {
  path: string;
  id?: string;
  type?: string;
}): string {
  return item.id && (item.type === "Task" || item.type === "Epic")
    ? workHref({ id: item.id })
    : `#/c/${item.path.split("/").map(encodeURIComponent).join("/")}`;
}

/** Hash routes use a second # for the document's section fragment. */
export function hashQuery(hash: string): string {
  return hash.replace(/^#/, "").split("#")[0]?.split("?")[1] ?? "";
}
