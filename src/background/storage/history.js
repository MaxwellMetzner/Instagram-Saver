const DOWNLOAD_HISTORY_LIMIT = 20;

const DOWNLOADED_MEDIA_KEY_LIMIT = 4000;

// Bulk download progress is persisted under the legacy "crawlJobs" key so saved progress survives upgrades.
const BULK_JOBS_STORAGE_KEY = "crawlJobs";

export async function getDownloadState() {
  const stored = await chrome.storage.local.get({
    downloadHistory: [],
    downloadedMediaKeys: [],
    [BULK_JOBS_STORAGE_KEY]: {}
  });
  const bulkJobs = stored[BULK_JOBS_STORAGE_KEY];

  return {
    downloadHistory: Array.isArray(stored.downloadHistory) ? stored.downloadHistory : [],
    downloadedMediaKeys: Array.isArray(stored.downloadedMediaKeys) ? stored.downloadedMediaKeys : [],
    bulkJobs: bulkJobs && typeof bulkJobs === "object" ? bulkJobs : {}
  };
}

export function buildDownloadKey(item) {
  return String(item?.mediaId || item?.postId || item?.url || "");
}

export async function getKnownDownloadKeys() {
  const state = await getDownloadState();
  return new Set(state.downloadedMediaKeys.filter(Boolean));
}

export async function saveDownloadState(downloadHistory, downloadedMediaKeys, bulkJobs = {}) {
  await chrome.storage.local.set({
    downloadHistory: downloadHistory.slice(0, DOWNLOAD_HISTORY_LIMIT),
    downloadedMediaKeys: downloadedMediaKeys.slice(-DOWNLOADED_MEDIA_KEY_LIMIT),
    [BULK_JOBS_STORAGE_KEY]: bulkJobs
  });
}

export async function recordDownloadHistory(plan, result) {
  const state = await getDownloadState();
  const historyEntry = {
    recordedAt: new Date().toISOString(),
    id: plan.meta.id,
    username: plan.meta.username,
    pageKind: plan.meta.pageKind,
    source: plan.meta.source,
    scope: plan.meta.downloadScope || "all",
    title: plan.meta.title || null,
    position: plan.meta.currentItem?.position || null,
    total: plan.meta.currentItem?.total || null,
    requested: result.requested,
    downloaded: result.downloaded,
    skipped: result.skipped,
    failed: result.failed,
    metadataFilename: result.metadata?.filename || null,
    reportFilename: result.report?.filename || null
  };

  const nextHistory = [historyEntry, ...state.downloadHistory].slice(0, DOWNLOAD_HISTORY_LIMIT);
  const nextKeys = [...state.downloadedMediaKeys, ...result.recordedKeys].slice(-DOWNLOADED_MEDIA_KEY_LIMIT);
  await saveDownloadState(nextHistory, nextKeys, state.bulkJobs);
}

export async function getDownloadHistory() {
  const state = await getDownloadState();
  return {
    ok: true,
    history: state.downloadHistory
  };
}

export async function exportDownloadHistory() {
  const state = await getDownloadState();
  const exportedAt = new Date().toISOString();
  const fileName = `instagram/history/download_history_${exportedAt.slice(0, 10)}.json`;
  const payload = {
    exportedAt,
    historyCount: state.downloadHistory.length,
    downloadedKeyCount: state.downloadedMediaKeys.length,
    history: state.downloadHistory
  };

  await chrome.downloads.download({
    url: `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(payload, null, 2))}`,
    filename: fileName,
    saveAs: false
  });

  return {
    ok: true,
    filename: fileName
  };
}

export async function clearDownloadHistory() {
  const state = await getDownloadState();
  await saveDownloadState([], [], state.bulkJobs);
  return { ok: true };
}
