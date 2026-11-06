import { toErrorDetails } from "../core/errors.js";
import { logWarn } from "../core/logger.js";
import { getCanonicalPageUrl } from "../instagram/urls.js";

const PREVIEW_CACHE_TTL_MS = 15000;

const PREVIEW_SESSION_STORAGE_KEY = "pagePreviewByTab";

export const previewCache = new Map();

export function buildPreviewCacheKey(tabUrl, settings) {
  const keyPayload = {
    tabUrl,
    duplicateMode: settings.duplicateMode,
    saveMetadataSidecar: settings.saveMetadataSidecar,
    placeMetadataInSubfolder: settings.placeMetadataInSubfolder,
    exportPostComments: settings.exportPostComments,
    maxProfilePosts: settings.maxProfilePosts,
    profileMediaFilter: settings.profileMediaFilter,
    folderTemplate: settings.folderTemplate,
    filenameTemplate: settings.filenameTemplate,
    metadataFilenameTemplate: settings.metadataFilenameTemplate
  };

  return JSON.stringify(keyPayload);
}

async function getSessionPreviewEntries() {
  try {
    const stored = await chrome.storage.session.get({
      [PREVIEW_SESSION_STORAGE_KEY]: {}
    });
    const entries = stored[PREVIEW_SESSION_STORAGE_KEY];
    return entries && typeof entries === "object" ? entries : {};
  } catch (err) {
    logWarn("preview_session_cache_read_failed", {
      error: toErrorDetails(err)
    });
    return {};
  }
}

export async function getSessionCachedPreview(tabId, cacheKey, tabUrl) {
  if (!tabId) return null;

  const entries = await getSessionPreviewEntries();
  const entry = entries[String(tabId)];
  if (!entry || entry.cacheKey !== cacheKey || entry.tabUrl !== tabUrl) {
    return null;
  }
  if (!Number.isFinite(entry.expiresAt) || entry.expiresAt <= Date.now()) {
    return null;
  }

  return entry.preview || null;
}

export async function setSessionCachedPreview(tabId, cacheKey, tabUrl, preview) {
  if (!tabId) return;

  try {
    const entries = await getSessionPreviewEntries();
    entries[String(tabId)] = {
      cacheKey,
      tabUrl,
      expiresAt: Date.now() + PREVIEW_CACHE_TTL_MS,
      preview
    };
    await chrome.storage.session.set({
      [PREVIEW_SESSION_STORAGE_KEY]: entries
    });
  } catch (err) {
    logWarn("preview_session_cache_write_failed", {
      tabId,
      error: toErrorDetails(err)
    });
  }
}

export async function clearSessionCachedPreviewForTab(tabId) {
  if (!tabId) return;

  try {
    const entries = await getSessionPreviewEntries();
    if (!Object.prototype.hasOwnProperty.call(entries, String(tabId))) {
      return;
    }

    delete entries[String(tabId)];
    if (Object.keys(entries).length > 0) {
      await chrome.storage.session.set({
        [PREVIEW_SESSION_STORAGE_KEY]: entries
      });
      return;
    }

    await chrome.storage.session.remove(PREVIEW_SESSION_STORAGE_KEY);
  } catch (err) {
    logWarn("preview_session_cache_clear_failed", {
      tabId,
      error: toErrorDetails(err)
    });
  }
}

export async function clearAllSessionCachedPreviews() {
  try {
    await chrome.storage.session.remove(PREVIEW_SESSION_STORAGE_KEY);
  } catch (err) {
    logWarn("preview_session_cache_reset_failed", {
      error: toErrorDetails(err)
    });
  }
}

export function getCachedPreview(cacheKey) {
  const cached = previewCache.get(cacheKey);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    previewCache.delete(cacheKey);
    return null;
  }

  return cached.preview;
}

export function setCachedPreview(cacheKey, preview) {
  previewCache.set(cacheKey, {
    preview,
    expiresAt: Date.now() + PREVIEW_CACHE_TTL_MS
  });
}

export function clearPreviewCacheForUrl(tabUrl) {
  if (!tabUrl) {
    previewCache.clear();
    return;
  }

  const needle = JSON.stringify({ tabUrl: getCanonicalPageUrl(tabUrl) }).slice(1, -1);
  for (const key of previewCache.keys()) {
    if (key.includes(needle)) {
      previewCache.delete(key);
    }
  }
}
