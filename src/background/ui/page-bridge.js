import { InstagramResolverError, toErrorDetails } from "../core/errors.js";
import { logWarn } from "../core/logger.js";
import { buildSummary } from "../plans/summary.js";

function isMissingReceiverError(err) {
  const message = String(err?.message || err || "").toLowerCase();
  return message.includes("receiving end does not exist") || message.includes("could not establish connection");
}

async function pingContentScript(tabId) {
  const response = await chrome.tabs.sendMessage(tabId, { type: "PING" });
  return response?.ok === true;
}

async function ensureContentScript(tabId) {
  try {
    const ready = await pingContentScript(tabId);
    if (ready) return;
  } catch (err) {
    if (!isMissingReceiverError(err)) {
      throw err;
    }
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["src/content/content.js"]
  });

  const readyAfterInjection = await pingContentScript(tabId);
  if (!readyAfterInjection) {
    throw new InstagramResolverError(
      "content_script_unavailable",
      "The extension UI could not be attached to this Instagram tab.",
      { tabId }
    );
  }
}

export async function sendToast(tabId, message, level = "info") {
  if (!tabId) return;

  try {
    await ensureContentScript(tabId);
    await chrome.tabs.sendMessage(tabId, {
      type: "SHOW_STATUS_TOAST",
      message,
      level
    });
  } catch (err) {
    logWarn("toast_send_failed", {
      tabId,
      message,
      error: toErrorDetails(err)
    });
  }
}

export async function requestDownloadConfirmation(tabId, plan) {
  await ensureContentScript(tabId);

  const response = await chrome.tabs.sendMessage(tabId, {
    type: "CONFIRM_DOWNLOAD",
    summary: buildSummary(plan)
  });

  return response?.confirmed === true;
}
