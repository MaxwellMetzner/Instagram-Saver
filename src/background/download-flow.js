import { InstagramResolverError, getErrorPresentation, toErrorDetails } from "./core/errors.js";
import { logError, logInfo, logWarn } from "./core/logger.js";
import { enrichPlanMetadata } from "./downloads/documents.js";
import { buildBatchReportFilename, ensureUniqueRelativePath } from "./downloads/filenames.js";
import { queueBatchReportDownload, queueDownloads } from "./downloads/queue.js";
import { getCanonicalPageUrl, isInstagramUrl, parseInstagramUrl } from "./instagram/urls.js";
import { buildProfileBatchDiagnostics } from "./plans/batch.js";
import { resolveDownloadPlan } from "./plans/resolve.js";
import {
  currentItemUnknownError,
  locateCurrentItem,
  selectCurrentItem,
  supportsCurrentItem
} from "./plans/selection.js";
import {
  buildPreviewCacheKey,
  clearPreviewCacheForUrl,
  setCachedPreview,
  setSessionCachedPreview
} from "./preview/cache.js";
import { buildPlanPreview } from "./preview/preview.js";
import { getSettings } from "./settings.js";
import { getKnownDownloadKeys, recordDownloadHistory } from "./storage/history.js";
import { BADGE_COLORS, clearBadgeSoon, setBadge } from "./ui/action.js";
import { requestDownloadConfirmation, sendToast } from "./ui/page-bridge.js";

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function describeResult(result) {
  const metadataNote = result.metadata ? " Info file saved." : "";
  const skippedNote = result.skipped ? ` Skipped ${plural(result.skipped, "file")} you already have.` : "";

  if (result.alreadyDownloaded) {
    return `You already have ${result.requested === 1 ? "this file" : "all of these files"}.${skippedNote}`;
  }

  return result.downloaded === 1
    ? `Download started.${metadataNote}${skippedNote}`
    : `Downloading ${result.downloaded} of ${plural(result.requested, "file")}.${metadataNote}${skippedNote}`;
}

/**
 * Downloads the media on the given tab.
 * scope "all" saves every item on the page; "current" saves only the slide/story/frame on screen.
 * Profiles and saved collections always use "all" (their quick download takes the latest posts).
 */
export async function runDownloadFlow(tab, mode, scope = "all") {
  if (!tab?.id) return;

  const tabId = tab.id;
  const tabUrl = tab.url || "";

  if (!isInstagramUrl(tabUrl)) {
    await setBadge(tabId, "ERR", BADGE_COLORS.error, "Open an Instagram page first");
    await sendToast(tabId, "Open an Instagram post, reel, story, highlight, or profile first.", "error");
    clearBadgeSoon(tabId, tabUrl);
    return {
      ok: false,
      error: getErrorPresentation(new InstagramResolverError(
        "unsupported_url",
        "Open an Instagram post, reel, story, highlight, or profile first.",
        { tabUrl }
      ))
    };
  }

  const descriptor = parseInstagramUrl(tabUrl);
  const wantsCurrent = scope === "current" && supportsCurrentItem(descriptor?.kind);

  try {
    const settings = await getSettings();
    clearPreviewCacheForUrl(tabUrl);
    await setBadge(tabId, "...", BADGE_COLORS.working, "Finding media on this page...");
    await sendToast(tabId, wantsCurrent ? "Finding the item on screen..." : "Finding media on this page...", "info");

    const resolvedPlan = await resolveDownloadPlan(tabUrl, settings, async (progress) => {
      await setBadge(tabId, `${progress.current}/${progress.total}`, BADGE_COLORS.working, `Reading posts ${progress.current}/${progress.total}`);
      if (progress.shouldNotify) {
        await sendToast(tabId, `Reading posts ${progress.current} of ${progress.total}...`, "info");
      }
    }, tabId);

    let selectedPlan = { ...resolvedPlan, meta: { ...resolvedPlan.meta, downloadScope: "all" } };
    if (wantsCurrent) {
      const location = await locateCurrentItem(descriptor, resolvedPlan.items, tabId);
      if (!location) {
        throw currentItemUnknownError(descriptor);
      }
      selectedPlan = selectCurrentItem(resolvedPlan, location);
    }

    const diagnosticPlan = {
      ...selectedPlan,
      meta: {
        ...selectedPlan.meta,
        batchDiagnostics: buildProfileBatchDiagnostics(selectedPlan.meta)
      }
    };
    const plan = await enrichPlanMetadata(diagnosticPlan, tabUrl, settings);
    logInfo("plan_resolved", {
      mode,
      scope: plan.meta.downloadScope,
      tabUrl,
      pageKind: plan.meta.pageKind,
      source: plan.meta.source,
      itemCount: plan.items.length,
      currentItem: plan.meta.currentItem || null
    });

    if (settings.confirmBeforeDownload) {
      const confirmed = await requestDownloadConfirmation(tabId, plan);
      if (!confirmed) {
        await setBadge(tabId, "CAN", BADGE_COLORS.error, "Download cancelled");
        await sendToast(tabId, "Download cancelled.", "info");
        clearBadgeSoon(tabId, tabUrl, 2200);
        return {
          ok: false,
          cancelled: true
        };
      }
    }

    await setBadge(tabId, "DL", BADGE_COLORS.working, "Starting download...");
    const result = await queueDownloads(plan, settings);

    if (settings.exportBatchReport) {
      try {
        const usedPaths = new Set(result.plannedFilenames || []);
        if (result.metadata?.filename) {
          usedPaths.add(result.metadata.filename);
        }
        const reportFilename = ensureUniqueRelativePath(
          buildBatchReportFilename(plan.meta, settings),
          `${plan.meta.id || plan.meta.username || "report"}`,
          usedPaths
        );
        result.report = await queueBatchReportDownload(plan, result, reportFilename, settings);
      } catch (err) {
        logWarn("batch_report_download_failed", {
          error: toErrorDetails(err)
        });
      }
    }

    await recordDownloadHistory(plan, result);

    const successMessage = describeResult(result);
    await setBadge(tabId, "OK", BADGE_COLORS.success, successMessage);
    await sendToast(tabId, successMessage, "success");
    clearBadgeSoon(tabId, tabUrl);

    if (result.failed > 0) {
      logWarn("partial_download_failure", {
        mode,
        tabUrl,
        requested: result.requested,
        downloaded: result.downloaded,
        failures: result.failures
      });
    }

    const preview = buildPlanPreview(plan, settings, await getKnownDownloadKeys());
    if (plan.meta.downloadScope !== "current") {
      const canonicalUrl = getCanonicalPageUrl(tabUrl);
      const cacheKey = buildPreviewCacheKey(canonicalUrl, settings);
      setCachedPreview(cacheKey, preview);
      await setSessionCachedPreview(tabId, cacheKey, canonicalUrl, preview);
    }

    return {
      ok: true,
      scope: plan.meta.downloadScope,
      currentItem: plan.meta.currentItem || null,
      result,
      preview
    };
  } catch (err) {
    const details = toErrorDetails(err);
    const presentation = getErrorPresentation(err);
    if (err instanceof InstagramResolverError) {
      logWarn("download_flow_failed", {
        mode,
        scope,
        tabUrl,
        error: presentation
      });
    } else {
      logError("download_flow_failed", err, { mode, scope, tabUrl });
    }
    await setBadge(tabId, "ERR", BADGE_COLORS.error, presentation.title);
    await sendToast(tabId, `${presentation.title}: ${details.message || "Unknown error"}`, "error");
    clearBadgeSoon(tabId, tabUrl, 6000);

    return {
      ok: false,
      error: presentation
    };
  }
}
