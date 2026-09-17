import { readBookmarks, writeBookmarks } from "./bookmarks.js";

const list = document.querySelector("#bookmarks");
const status = document.querySelector("#status");
const form = document.querySelector("#add-bookmark");
const bookmarks = readBookmarks(localStorage);

function render() {
  list.replaceChildren();
  for (const [index, bookmark] of bookmarks.entries()) {
    const item = document.createElement("li");
    item.dataset.bookmark = String(index);
    const title = document.createElement("strong");
    title.textContent = bookmark.title;
    const url = document.createElement("p");
    url.textContent = bookmark.url;
    const tags = document.createElement("p");
    tags.textContent = bookmark.tags.join(" · ");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${bookmark.title}`);
    remove.addEventListener("click", () => {
      bookmarks.splice(index, 1);
      writeBookmarks(localStorage, bookmarks);
      render();
    });
    item.append(title, url, tags, remove);
    list.append(item);
  }
  status.textContent = `${bookmarks.length} saved bookmark${bookmarks.length === 1 ? "" : "s"}`;
  document.documentElement.dataset.beaconReady = "true";
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(form);
  bookmarks.push({
    title: String(data.get("title")).trim(),
    url: String(data.get("url")).trim(),
    tags: String(data.get("tags"))
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
  });
  writeBookmarks(localStorage, bookmarks);
  form.reset();
  render();
});

render();
