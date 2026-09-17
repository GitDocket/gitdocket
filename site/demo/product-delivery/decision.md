# Retained export contract

Beacon version-one export is a whole-library local JSON download with the exact envelope `{ "schemaVersion": 1, "bookmarks": [...] }`. Each bookmark contains only the existing `title`, `url` and `tags` fields in their existing order, with Unicode preserved. The fixed filename is `beacon-bookmarks.json`; an explicitly empty saved collection exports `bookmarks: []`. Export does not mutate storage, fetch stored URLs or add a dependency.

---

Excerpt from the observed synthetic Beacon qualification. Verbatim paragraph from an observed agent-authored record. Source identity and assistance limits are retained in [the receipt](receipt.json). This is historical evidence, not setup content or approval for a new run.
