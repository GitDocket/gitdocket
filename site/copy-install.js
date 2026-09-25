const installCommand = "brew install gitdocket/tap/gitdocket";

for (const button of document.querySelectorAll("button.copy-command")) {
  button.addEventListener("click", async () => {
    const status = document.getElementById(button.getAttribute("aria-describedby"));
    const value = button.getAttribute("data-copy");
    if (!status || value !== installCommand) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(value);
      status.textContent = "Copied";
    } catch {
      status.textContent = "Could not copy. Select the command and copy it manually.";
    }
  });
}
