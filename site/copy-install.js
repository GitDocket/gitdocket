// Enhance code blocks without changing their selectable, copyable text.
for (const [index, pre] of [...document.querySelectorAll("pre")].entries()) {
  const code = pre.querySelector("code");
  if (!code || pre.closest(".install-chip")) continue;

  const block = document.createElement("div");
  block.className = "code-block";
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
  pre.before(block);
  if (label === "Copy example") block.classList.add("example-block");
  if (label === "Copy JSON") block.classList.add("json-block");
  block.append(pre, button, status);
}

for (const button of document.querySelectorAll("button.copy-command")) {
  const code = button
    .closest(".code-block, .install-chip")
    ?.querySelector("pre code");
  const status = document.getElementById(
    button.getAttribute("aria-describedby"),
  );
  if (!code || !status) continue;
  button.hidden = false;
  const label = button.textContent;
  let resetTimer;
  button.addEventListener("click", async () => {
    clearTimeout(resetTimer);
    status.classList.remove("copy-error");
    status.textContent = "Copying…";
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(code.textContent);
      status.textContent = "Copied";
      if (button.closest(".code-block")) button.textContent = "Copied";
      resetTimer = setTimeout(() => {
        button.textContent = label;
        status.textContent = "";
      }, 2000);
    } catch {
      button.textContent = label;
      status.classList.add("copy-error");
      status.textContent = "Could not copy. Select the text and copy manually.";
    }
  });
}
