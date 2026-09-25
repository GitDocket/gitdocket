# Local-server safety

`docket serve` is a same-computer interface over the current repository. It binds to IPv4 loopback (`127.0.0.1`) and exposes no host override in the first public preview.

The server rejects non-loopback `Host` values. Browser write requests must also carry a same-origin `Origin`; origin-less local clients remain supported. These checks reduce browser-origin and DNS-rebinding risks while keeping the command useful for local tools.

The server has no authentication, authorization, TLS, multi-user isolation, or network deployment contract. Do not place it behind a public tunnel, reverse proxy, LAN address, container ingress, or hosted endpoint. If another person needs access, share the underlying Git repository and let them run their own local process.

`--watch` rebuilds browser assets during frontend development. `--commit` lets supported UI writes create one commit per operation. Each commit is built from an isolated temporary index containing only the operation-owned paths, while unrelated staged, unstaged, untracked, and partially staged work remains intact. Repository hooks and configured signing still apply.

Serve refuses an automatic commit during a merge, rebase, cherry-pick, or revert. It publishes through a bounded compare-and-swap `HEAD` update: an unrelated concurrent commit becomes the new parent on retry, while a concurrent change to an operation-owned path fails closed. If commit construction fails, the UI write remains in the working tree, temporary state is removed, and Serve reports the Git condition without sweeping the live index.

Neither flag changes the loopback boundary.


## Create a wiki page

Use **Wiki → New page** to create a Reference, Spec or Playbook in the configured bundle. The title suggests a conventional location; the location remains editable before Save. The shared Markdown editor provides preview and retains the title, description, type, location and content during validation, network and collision errors. Existing destinations are never overwritten. Cancel confirms discarding a modified draft and returns to Wiki.

Save opens the page, refreshes Wiki/search and reports its Git state. With `--commit`, the shared committer commits only the created source and reports commit failures separately from a successful local save. Creation never starts tracked work or selects project guidance. New-page drafts use the same browser-session recovery limits as existing document edits.
