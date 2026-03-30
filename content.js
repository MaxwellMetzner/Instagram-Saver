let statusToastEl = null;
let statusToastTimer = null;

function showStatusToast(message, level = "info") {
  if (!message) return;

  if (!statusToastEl) {
    statusToastEl = document.createElement("div");
    statusToastEl.style.position = "fixed";
    statusToastEl.style.top = "16px";
    statusToastEl.style.right = "16px";
    statusToastEl.style.padding = "10px 14px";
    statusToastEl.style.borderRadius = "10px";
    statusToastEl.style.color = "#fff";
    statusToastEl.style.fontFamily = "system-ui, -apple-system, Segoe UI, sans-serif";
    statusToastEl.style.fontSize = "13px";
    statusToastEl.style.fontWeight = "600";
    statusToastEl.style.zIndex = "2147483647";
    statusToastEl.style.boxShadow = "0 8px 24px rgba(0, 0, 0, 0.28)";
    statusToastEl.style.pointerEvents = "none";
    statusToastEl.style.opacity = "0";
    statusToastEl.style.transition = "opacity 120ms ease";
    document.documentElement.appendChild(statusToastEl);
  }

  const backgroundByLevel = {
    info: "rgba(30, 64, 175, 0.95)",
    success: "rgba(21, 128, 61, 0.95)",
    error: "rgba(185, 28, 28, 0.95)"
  };

  statusToastEl.textContent = message;
  statusToastEl.style.background = backgroundByLevel[level] || backgroundByLevel.info;
  statusToastEl.style.opacity = "1";

  if (statusToastTimer) {
    clearTimeout(statusToastTimer);
  }

  statusToastTimer = setTimeout(() => {
    if (statusToastEl) {
      statusToastEl.style.opacity = "0";
    }
  }, 2800);
}

function buildConfirmMessage(summary) {
  const username = summary?.username ? `@${summary.username}` : "this Instagram page";
  const kind = summary?.pageKind || "media";
  const totalCount = Number(summary?.totalCount || 0);
  const imageCount = Number(summary?.imageCount || 0);
  const videoCount = Number(summary?.videoCount || 0);
  const lines = [
    `Download ${totalCount} file${totalCount === 1 ? "" : "s"} from ${username}?`,
    "",
    `Type: ${kind}`,
    `Images: ${imageCount}`,
    `Videos: ${videoCount}`
  ];

  if (summary?.isFullCrawl) {
    lines.push(
      "",
      "This starts the full-profile crawl.",
      "The extension popup may close after this prompt.",
      "The crawl will keep running in the background until the profile ends or Instagram rate limits it."
    );
  }

  return lines.join("\n");
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg?.type) return false;

  try {
    if (msg.type === "PING") {
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === "SHOW_STATUS_TOAST") {
      showStatusToast(msg.message, msg.level);
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === "CONFIRM_DOWNLOAD") {
      const confirmed = window.confirm(buildConfirmMessage(msg.summary || {}));
      sendResponse({ confirmed });
      return false;
    }
  } catch (err) {
    sendResponse({
      ok: false,
      error: String(err)
    });
    return false;
  }

  return false;
});
