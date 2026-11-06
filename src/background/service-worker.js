import { MESSAGE_TYPES } from "../shared/messages.js";
import {
  getBulkJobStatus,
  pauseBulkDownload,
  resetBulkDownload,
  startBulkDownload
} from "./bulk/runner.js";
import { getErrorPresentation, toErrorDetails } from "./core/errors.js";
import { logWarn } from "./core/logger.js";
import { runDownloadFlow } from "./download-flow.js";
import { getCanonicalPageUrl } from "./instagram/urls.js";
import {
  clearAllSessionCachedPreviews,
  clearPreviewCacheForUrl,
  clearSessionCachedPreviewForTab,
  previewCache
} from "./preview/cache.js";
import { getPagePreview } from "./preview/preview.js";
import { getSettings } from "./settings.js";
import { clearDownloadHistory, exportDownloadHistory, getDownloadHistory } from "./storage/history.js";
import { badgeRefreshTimers, scheduleAvailabilityBadgeRefresh, syncActionPresentation } from "./ui/action.js";
import { CONTEXT_MENUS, getMenuScope } from "./ui/context-menu.js";

// Last page (URL without query/hash) seen per tab, so carousel slide changes don't throw away the preview.
const tabPages = new Map();

function warnOnFailure(event, details = {}) {
  return (err) => logWarn(event, { ...details, error: toErrorDetails(err) });
}

function tabFromMessage(message) {
  return { id: message.tabId, url: message.tabUrl };
}

const messageHandlers = {
  [MESSAGE_TYPES.GET_PAGE_PREVIEW]: (message) => getPagePreview(tabFromMessage(message), message.forceRefresh === true),
  [MESSAGE_TYPES.START_PAGE_DOWNLOAD]: (message) =>
    runDownloadFlow(tabFromMessage(message), "popup_download", message.scope === "current" ? "current" : "all"),
  [MESSAGE_TYPES.GET_BULK_STATUS]: (message) => getBulkJobStatus(tabFromMessage(message)),
  [MESSAGE_TYPES.START_BULK_DOWNLOAD]: (message) => startBulkDownload(tabFromMessage(message)),
  [MESSAGE_TYPES.PAUSE_BULK_DOWNLOAD]: (message) => pauseBulkDownload(tabFromMessage(message)),
  [MESSAGE_TYPES.RESET_BULK_DOWNLOAD]: (message) => resetBulkDownload(tabFromMessage(message)),
  [MESSAGE_TYPES.GET_DOWNLOAD_HISTORY]: () => getDownloadHistory(),
  [MESSAGE_TYPES.EXPORT_DOWNLOAD_HISTORY]: () => exportDownloadHistory(),
  [MESSAGE_TYPES.CLEAR_DOWNLOAD_HISTORY]: () => clearDownloadHistory()
};

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.contextMenus.removeAll();
  for (const menu of CONTEXT_MENUS) {
    chrome.contextMenus.create({
      id: menu.id,
      title: menu.title,
      contexts: ["page", "image", "video"],
      documentUrlPatterns: ["https://*.instagram.com/*"]
    });
  }

  await syncActionPresentation();
});

chrome.action.onClicked.addListener(async (tab) => {
  const settings = await getSettings();
  if (!settings.easyMode) {
    return;
  }

  await runDownloadFlow(tab, "action_click", settings.defaultDownloadScope);
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const scope = getMenuScope(info.menuItemId);
  if (scope) {
    await runDownloadFlow(tab, `context_${scope}`, scope);
  }
});

chrome.runtime.onStartup.addListener(() => {
  syncActionPresentation().catch(warnOnFailure("action_presentation_startup_failed"));
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") {
    return;
  }

  previewCache.clear();
  clearAllSessionCachedPreviews().catch(warnOnFailure("preview_session_cache_sync_reset_failed"));

  if (changes.easyMode) {
    syncActionPresentation().catch(warnOnFailure("action_presentation_sync_failed"));
    return;
  }

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (chrome.runtime.lastError) {
      return;
    }

    const [activeTab] = tabs || [];
    if (activeTab?.id) {
      scheduleAvailabilityBadgeRefresh(activeTab);
    }
  });
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    scheduleAvailabilityBadgeRefresh(tab);
  } catch (err) {
    warnOnFailure("tab_activation_badge_failed", { tabId })(err);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    const nextPage = getCanonicalPageUrl(changeInfo.url);
    const previousPage = tabPages.get(tabId);
    tabPages.set(tabId, nextPage);

    if (previousPage === nextPage) {
      // Only the query changed (e.g. ?img_index= while swiping a carousel); the page's media is the same.
      return;
    }

    if (previousPage) {
      clearPreviewCacheForUrl(previousPage);
    } else {
      previewCache.clear();
    }
    clearSessionCachedPreviewForTab(tabId).catch(warnOnFailure("preview_session_cache_tab_update_clear_failed", { tabId }));
  }

  if (!changeInfo.url && changeInfo.status !== "complete") {
    return;
  }

  scheduleAvailabilityBadgeRefresh({
    id: tabId,
    url: tab.url || changeInfo.url || ""
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabPages.delete(tabId);
  clearTimeout(badgeRefreshTimers.get(tabId));
  badgeRefreshTimers.delete(tabId);
  clearSessionCachedPreviewForTab(tabId).catch(warnOnFailure("preview_session_cache_tab_remove_clear_failed", { tabId }));
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = message?.type ? messageHandlers[message.type] : null;
  if (!handler) {
    return false;
  }

  Promise.resolve()
    .then(() => handler(message))
    .then((result) => sendResponse(result || { ok: false }))
    .catch((err) => sendResponse({ ok: false, error: getErrorPresentation(err) }));
  return true;
});

syncActionPresentation().catch(warnOnFailure("action_presentation_bootstrap_failed"));
