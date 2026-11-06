// Runs inside Instagram tabs: shows status toasts and the download confirmation prompt.
// Loaded as a classic content script, so it cannot import shared modules.

const TOAST_COLORS = {
  info: "#2563eb",
  success: "#16a34a",
  error: "#dc2626"
};

const PAGE_KIND_NAMES = {
  post: "post",
  reel: "reel",
  story: "story",
  highlight: "highlight",
  profile: "profile",
  saved: "saved posts"
};

let statusToastEl = null;
let statusToastTimer = null;

function ensureToastElement() {
  if (statusToastEl?.isConnected) {
    return statusToastEl;
  }

  statusToastEl = document.createElement("div");
  statusToastEl.setAttribute("role", "status");
  statusToastEl.setAttribute("aria-live", "polite");
  Object.assign(statusToastEl.style, {
    position: "fixed",
    top: "16px",
    right: "16px",
    maxWidth: "360px",
    padding: "10px 14px 10px 12px",
    borderRadius: "12px",
    borderLeft: "4px solid transparent",
    background: "rgba(17, 24, 39, 0.94)",
    color: "#f9fafb",
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
    fontSize: "13px",
    fontWeight: "500",
    lineHeight: "1.4",
    zIndex: "2147483647",
    boxShadow: "0 12px 32px rgba(0, 0, 0, 0.3)",
    pointerEvents: "none",
    opacity: "0",
    transform: "translateY(-6px)",
    transition: "opacity 140ms ease, transform 140ms ease"
  });
  document.documentElement.appendChild(statusToastEl);
  return statusToastEl;
}

function showStatusToast(message, level = "info") {
  if (!message) return;

  const toast = ensureToastElement();
  toast.textContent = message;
  toast.style.borderLeftColor = TOAST_COLORS[level] || TOAST_COLORS.info;
  toast.style.opacity = "1";
  toast.style.transform = "translateY(0)";

  clearTimeout(statusToastTimer);
  statusToastTimer = setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(-6px)";
  }, level === "error" ? 5000 : 2800);
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function buildConfirmMessage(summary) {
  const owner = summary?.username ? `@${summary.username}` : "this Instagram page";
  const kind = PAGE_KIND_NAMES[summary?.pageKind] || "page";
  const totalCount = Number(summary?.totalCount || 0);
  const imageCount = Number(summary?.imageCount || 0);
  const videoCount = Number(summary?.videoCount || 0);
  const current = summary?.downloadScope === "current" ? summary.currentItem : null;

  const heading = current
    ? `Download item ${current.position} of ${current.total} from ${owner}'s ${kind}?`
    : `Download ${plural(totalCount, "file")} from ${owner}'s ${kind}?`;

  const lines = [heading, "", `${plural(imageCount, "photo")}, ${plural(videoCount, "video")}`];

  if (current?.method === "assumed") {
    lines.push("", "Couldn't see which slide is showing, so the first slide will be saved.");
  }

  if (summary?.isBulk) {
    lines.push(
      "",
      "This is part of a bulk download. It keeps going in the background",
      "and pauses on its own if Instagram asks it to slow down."
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
