const root = document.getElementById("ar-chrome-login-import");
const button = document.getElementById("ar-confirm-import");
const statusElement = document.getElementById("ar-import-status");

if (root && button && statusElement) {
  const importUrl = root.getAttribute("data-import-url") || "";
  button.disabled = false;
  button.textContent = "Confirm and Import";
  setStatus("AgentRouter Login Import extension is connected. Review the domains, then confirm.");

  button.addEventListener("click", () => {
    void confirmImport(importUrl);
  });
}

async function confirmImport(importUrl) {
  button.disabled = true;
  setStatus("Importing Chrome cookies and localStorage into AgentRouter...");
  try {
    const response = await chrome.runtime.sendMessage({
      importUrl,
      type: "ar-login-import-confirm"
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Chrome login import failed.");
    }
    const result = response.result || {};
    setStatus(
      `Imported ${result.cookieImported || 0} cookies and ${result.localStorageImported || 0} localStorage items. Skipped ${result.skipped || 0}.`,
      "ok"
    );
    button.textContent = "Imported";
  } catch (error) {
    button.disabled = false;
    setStatus(formatError(error), "error");
  }
}

function setStatus(message, kind = "") {
  statusElement.textContent = message;
  statusElement.className = `status ${kind}`.trim();
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
