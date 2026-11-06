import { getBulkJobStatus } from "../bulk/runner.js";
import { InstagramResolverError } from "../core/errors.js";
import { enrichPlanMetadata } from "../downloads/documents.js";
import { buildMetadataFilename, buildPlannedEntries, ensureUniqueRelativePath } from "../downloads/filenames.js";
import { getCanonicalPageUrl, isInstagramUrl, parseInstagramUrl } from "../instagram/urls.js";
import { buildProfileBatchDiagnostics } from "../plans/batch.js";
import { resolveDownloadPlan } from "../plans/resolve.js";
import { locateCurrentItem, supportsCurrentItem } from "../plans/selection.js";
import { buildSummary } from "../plans/summary.js";
import {
  buildPreviewCacheKey,
  clearPreviewCacheForUrl,
  clearSessionCachedPreviewForTab,
  getCachedPreview,
  getSessionCachedPreview,
  setCachedPreview,
  setSessionCachedPreview
} from "./cache.js";
import { getSettings } from "../settings.js";
import { getKnownDownloadKeys } from "../storage/history.js";

export function buildPlanPreview(plan, settings, knownDownloadKeys = new Set()) {
  const summary = buildSummary(plan);
  const includeMatchKeys = supportsCurrentItem(plan.meta.pageKind);
  const plannedEntries = buildPlannedEntries(plan, settings, knownDownloadKeys);
  const items = plannedEntries.map((entry) => ({
    index: entry.index + 1,
    type: entry.item.type,
    filename: entry.filename,
    sourceUrl: entry.item.url,
    width: entry.item.width,
    height: entry.item.height,
    timestamp: entry.item.timestamp,
    expiresAt: entry.item.expiresAt || null,
    mediaId: entry.item.mediaId || null,
    matchKeys: includeMatchKeys ? entry.item.matchKeys || [] : undefined,
    downloadKey: entry.downloadKey || null,
    alreadyDownloaded: entry.alreadyDownloaded
  }));

  const duplicateCount = items.filter((item) => item.alreadyDownloaded).length;
  const metadataFilename = settings.saveMetadataSidecar
    ? ensureUniqueRelativePath(
        buildMetadataFilename(plan.meta, settings),
        `${plan.meta.id || plan.meta.username || "metadata"}`,
        new Set(items.map((item) => item.filename))
      )
    : null;

  return {
    ok: true,
    summary: {
      ...summary,
      source: plan.meta.source,
      title: plan.meta.title || null,
      duplicateCount,
      duplicateMode: settings.duplicateMode,
      maxProfilePosts: settings.maxProfilePosts,
      profileMediaFilter: settings.profileMediaFilter,
      metadataEnabled: settings.saveMetadataSidecar,
      metadataFilename,
      batchDiagnostics: plan.meta.batchDiagnostics || []
    },
    meta: plan.meta,
    items
  };
}

async function refreshDuplicateState(preview, settings) {
  let items = Array.isArray(preview.items) ? preview.items : [];
  if (settings.duplicateMode === "history") {
    const knownDownloadKeys = await getKnownDownloadKeys();
    items = items.map((item) => ({
      ...item,
      alreadyDownloaded: item.downloadKey
        ? knownDownloadKeys.has(item.downloadKey)
        : Boolean(item.alreadyDownloaded)
    }));
  } else {
    items = items.map((item) => ({
      ...item,
      alreadyDownloaded: false
    }));
  }

  return {
    ...preview,
    items,
    summary: {
      ...preview.summary,
      duplicateCount: items.filter((item) => item.alreadyDownloaded).length,
      duplicateMode: settings.duplicateMode
    }
  };
}

// Adds the parts of a preview that change while the page stays the same: the on-screen item and bulk progress.
async function addLiveState(preview, tab) {
  const descriptor = parseInstagramUrl(tab.url);
  const pageKind = preview.summary?.pageKind;
  let current = null;

  if (supportsCurrentItem(pageKind) && preview.items.length > 1) {
    const location = await locateCurrentItem(descriptor, preview.items, tab.id);
    current = location
      ? {
        index: location.index,
        position: location.index + 1,
        total: preview.items.length,
        method: location.method,
        type: preview.items[location.index]?.type || null,
        alreadyDownloaded: Boolean(preview.items[location.index]?.alreadyDownloaded)
      }
      : { index: null, position: null, total: preview.items.length, method: "unknown", type: null, alreadyDownloaded: false };
  }

  const bulkJob = pageKind === "profile" || pageKind === "saved"
    ? (await getBulkJobStatus(tab)).bulkJob
    : null;

  return {
    ...preview,
    current,
    bulkJob
  };
}

export async function getPagePreview(tab, forceRefresh = false) {
  const tabUrl = tab?.url || "";
  if (!tab?.id || !isInstagramUrl(tabUrl)) {
    throw new InstagramResolverError(
      "unsupported_url",
      "Open an Instagram post, reel, story, highlight, or profile first.",
      { tabUrl }
    );
  }

  const settings = await getSettings();
  const canonicalUrl = getCanonicalPageUrl(tabUrl);
  if (forceRefresh) {
    clearPreviewCacheForUrl(tabUrl);
    await clearSessionCachedPreviewForTab(tab.id);
  }
  const cacheKey = buildPreviewCacheKey(canonicalUrl, settings);
  const cachedPreview = getCachedPreview(cacheKey);
  if (cachedPreview) {
    return addLiveState(await refreshDuplicateState(cachedPreview, settings), tab);
  }

  const sessionCachedPreview = await getSessionCachedPreview(tab.id, cacheKey, canonicalUrl);
  if (sessionCachedPreview) {
    setCachedPreview(cacheKey, sessionCachedPreview);
    return addLiveState(await refreshDuplicateState(sessionCachedPreview, settings), tab);
  }

  const resolvedPlan = await resolveDownloadPlan(tabUrl, settings, null, tab.id);
  const diagnosticPlan = {
    ...resolvedPlan,
    meta: {
      ...resolvedPlan.meta,
      batchDiagnostics: buildProfileBatchDiagnostics(resolvedPlan.meta)
    }
  };
  const plan = await enrichPlanMetadata(diagnosticPlan, tabUrl, settings);
  const knownDownloadKeys = settings.duplicateMode === "history" ? await getKnownDownloadKeys() : new Set();
  const preview = buildPlanPreview(plan, settings, knownDownloadKeys);
  setCachedPreview(cacheKey, preview);
  await setSessionCachedPreview(tab.id, cacheKey, canonicalUrl, preview);
  return addLiveState(preview, tab);
}
