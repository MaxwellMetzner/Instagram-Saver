import { InstagramResolverError, toErrorDetails } from "../core/errors.js";
import { logError, logWarn } from "../core/logger.js";
import { createBatchReportDocument, createMetadataDocument } from "./documents.js";
import { buildMetadataFilename, buildPlannedEntries, ensureUniqueRelativePath } from "./filenames.js";
import { getKnownDownloadKeys } from "../storage/history.js";

async function queueMetadataDownload(plan, queuedDownloads, metadataFilename) {
  const metadata = createMetadataDocument(plan, queuedDownloads);
  const dataUrl = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(metadata, null, 2))}`;

  const downloadId = await chrome.downloads.download({
    url: dataUrl,
    filename: metadataFilename,
    saveAs: false
  });

  return {
    downloadId,
    filename: metadataFilename
  };
}

export async function queueBatchReportDownload(plan, result, reportFilename, settings) {
  const report = createBatchReportDocument(plan, result, settings);
  const dataUrl = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(report, null, 2))}`;

  const downloadId = await chrome.downloads.download({
    url: dataUrl,
    filename: reportFilename,
    saveAs: false
  });

  return {
    downloadId,
    filename: reportFilename
  };
}

export async function queueDownloads(plan, settings) {
  const queuedDownloads = [];
  const failures = [];
  const skippedItems = [];
  const recordedKeys = [];
  const knownDownloadKeys = settings.duplicateMode === "history" ? await getKnownDownloadKeys() : new Set();
  const plannedEntries = buildPlannedEntries(plan, settings, knownDownloadKeys);

  for (const entry of plannedEntries) {
    const { item, filename, downloadKey, alreadyDownloaded } = entry;

    if (downloadKey && alreadyDownloaded) {
      skippedItems.push({
        item,
        filename,
        reason: "already_downloaded"
      });
      continue;
    }

    try {
      const downloadId = await chrome.downloads.download({
        url: item.url,
        filename,
        saveAs: plan.items.length === 1 ? settings.promptForSingleDownload : false
      });

      queuedDownloads.push({
        downloadId,
        filename,
        item
      });

      if (downloadKey) {
        knownDownloadKeys.add(downloadKey);
        recordedKeys.push(downloadKey);
      }
    } catch (err) {
      failures.push({
        item,
        filename,
        error: toErrorDetails(err)
      });
      logError("download_queue_failed", err, {
        filename,
        url: item.url
      });
    }
  }

  if (!queuedDownloads.length && skippedItems.length && !failures.length) {
    return {
      requested: plan.items.length,
      downloaded: 0,
      skipped: skippedItems.length,
      skippedItems,
      failed: 0,
      failures: [],
      metadata: null,
      alreadyDownloaded: true,
      recordedKeys: [],
      plannedFilenames: plannedEntries.map((entry) => entry.filename)
    };
  }

  if (!queuedDownloads.length) {
    throw new InstagramResolverError(
      "download_failed",
      failures[0]?.error?.message || "All downloads failed.",
      { failures }
    );
  }

  let metadataResult = null;
  if (settings.saveMetadataSidecar) {
    try {
      const usedPaths = new Set(plannedEntries.map((entry) => entry.filename));
      const metadataFilename = ensureUniqueRelativePath(
        buildMetadataFilename(plan.meta, settings),
        `${plan.meta.id || plan.meta.username || "metadata"}`,
        usedPaths
      );
      metadataResult = await queueMetadataDownload(plan, queuedDownloads, metadataFilename);
    } catch (err) {
      logWarn("metadata_download_failed", {
        error: toErrorDetails(err)
      });
    }
  }

  return {
    requested: plan.items.length,
    downloaded: queuedDownloads.length,
    skipped: skippedItems.length,
    skippedItems,
    failed: failures.length,
    failures,
    metadata: metadataResult,
    recordedKeys,
    alreadyDownloaded: false,
    plannedFilenames: plannedEntries.map((entry) => entry.filename)
  };
}
