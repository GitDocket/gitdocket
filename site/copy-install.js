// Enhance code blocks without changing their selectable, copyable text.
for (const [index, pre] of [...document.querySelectorAll("pre")].entries()) {
  const code = pre.querySelector("code");
  if (!code || pre.closest(".install-chip, .command-row")) continue;

  const block = document.createElement("div");
  block.className = "code-block";
  const toolbar = document.createElement("div");
  toolbar.className = "code-toolbar";
  const status = document.createElement("span");
  status.id = `copy-status-block-${index}`;
  status.className = "copy-status";
  status.setAttribute("role", "status");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "copy-command";
  const label = code.classList.contains("language-json")
    ? "Copy JSON"
    : code.classList.contains("language-mcp")
      ? "Copy example"
      : "Copy";
  button.textContent = label;
  button.setAttribute("aria-label", `${label} block ${index + 1}`);
  button.setAttribute("aria-describedby", status.id);
  toolbar.append(status, button);
  pre.before(block);
  block.append(toolbar, pre);
}

for (const button of document.querySelectorAll("button.copy-command")) {
  const code = button
    .closest(".code-block, .install-chip, .command-row")
    ?.querySelector("pre code");
  const status = document.getElementById(
    button.getAttribute("aria-describedby"),
  );
  if (!code || !status) continue;
  button.hidden = false;
  button.addEventListener("click", async () => {
    status.textContent = "Copying…";
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(code.textContent);
      status.textContent = "Copied";
    } catch {
      status.textContent = "Could not copy. Select the text and copy manually.";
    }
  });
}
