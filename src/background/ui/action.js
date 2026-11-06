import { getErrorPresentation, toErrorDetails } from "../core/errors.js";
import { logWarn } from "../core/logger.js";
import { isInstagramUrl } from "../instagram/urls.js";
import { resolveDownloadPlan } from "../plans/resolve.js";
import { getSettings } from "../settings.js";

const DEFAULT_ACTION_TITLE = "Download media from the current Instagram page";

const DEFAULT_POPUP_PATH = "src/popup/popup.html";

const BADGE_REFRESH_DELAY_MS = 350;

export const BADGE_COLORS = {
  working: "#1D4ED8",
  success: "#15803D",
  error: "#B91C1C"
};

export const badgeRefreshTimers = new Map();

function getEasyModeProbeSettings(settings) {
  return {
    ...settings,
    exportPostComments: false,
    maxProfilePosts: 1
  };
}

async function clearBadge(tabId, title = DEFAULT_ACTION_TITLE) {
  if (!tabId) return;

  try {
    await chrome.action.setBadgeText({ tabId, text: "" });
    await chrome.action.setTitle({ tabId, title });
  } catch (err) {
    logWarn("badge_clear_failed", {
      tabId,
      error: toErrorDetails(err)
    });
  }
}

export async function setBadge(tabId, text, color, title) {
  if (!tabId) return;

  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
    await chrome.action.setBadgeText({ tabId, text });
    if (title) {
      await chrome.action.setTitle({ tabId, title });
    }
  } catch (err) {
    logWarn("badge_set_failed", {
      tabId,
      text,
      error: toErrorDetails(err)
    });
  }
}

async function syncActionAvailability(tab, settings = null) {
  const tabId = tab?.id;
  if (!tabId) {
    return false;
  }

  const tabUrl = tab?.url || "";
  const isSupportedTab = isInstagramUrl(tabUrl);

  try {
    if (!isSupportedTab) {
      await chrome.action.disable(tabId);
      await clearBadge(tabId, "Open an Instagram page to use this extension");
      return false;
    }

    await chrome.action.enable(tabId);
    if (!(settings || await getSettings()).easyMode) {
      await clearBadge(tabId);
    }
    return true;
  } catch (err) {
    logWarn("action_availability_sync_failed", {
      tabId,
      error: toErrorDetails(err)
    });
    return isSupportedTab;
  }
}

export async function syncActionPresentation(settings = null) {
  const resolvedSettings = settings || await getSettings();
  await chrome.action.setPopup({
    popup: resolvedSettings.easyMode ? "" : DEFAULT_POPUP_PATH
  });

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.id) {
    await syncActionAvailability(activeTab, resolvedSettings);
    scheduleAvailabilityBadgeRefresh(activeTab);
  }
}

async function updateAvailabilityBadge(tab) {
  const settings = await getSettings();
  const tabId = tab?.id;
  const tabUrl = tab?.url || "";

  if (!tabId) {
    return;
  }

  const actionEnabled = await syncActionAvailability(tab, settings);
  if (!actionEnabled) {
    return;
  }

  if (!settings.easyMode) {
    await clearBadge(tabId);
    return;
  }

  if (!isInstagramUrl(tabUrl)) {
    await clearBadge(tabId);
    return;
  }

  try {
    await resolveDownloadPlan(tabUrl, getEasyModeProbeSettings(settings), null, tabId);
    await setBadge(
      tabId,
      "OK",
      BADGE_COLORS.success,
      "This Instagram page is ready to download"
    );
  } catch (err) {
    const presentation = getErrorPresentation(err);
    await setBadge(tabId, "NO", BADGE_COLORS.error, presentation.title);
  }
}

export function scheduleAvailabilityBadgeRefresh(tab) {
  const tabId = tab?.id;
  if (!tabId) {
    return;
  }

  clearTimeout(badgeRefreshTimers.get(tabId));
  const timeoutId = setTimeout(async () => {
    badgeRefreshTimers.delete(tabId);
    try {
      await updateAvailabilityBadge(tab);
    } catch (err) {
      logWarn("availability_badge_refresh_failed", {
        tabId,
        error: toErrorDetails(err)
      });
    }
  }, BADGE_REFRESH_DELAY_MS);

  badgeRefreshTimers.set(tabId, timeoutId);
}

export function clearBadgeSoon(tabId, tabUrl, delayMs = 3500) {
  if (!tabId) return;

  setTimeout(async () => {
    const settings = await getSettings();
    if (settings.easyMode) {
      scheduleAvailabilityBadgeRefresh({ id: tabId, url: tabUrl || "" });
      return;
    }

    await clearBadge(tabId);
  }, delayMs);
}
