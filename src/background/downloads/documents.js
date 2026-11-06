import { toErrorDetails } from "../core/errors.js";
import { logWarn } from "../core/logger.js";
import { fetchPostComments } from "../instagram/posts.js";

export function createMetadataDocument(plan, queuedDownloads) {
  return {
    generatedAt: new Date().toISOString(),
    source: plan.meta.source,
    pageKind: plan.meta.pageKind,
    downloadScope: plan.meta.downloadScope || "all",
    id: plan.meta.id,
    username: plan.meta.username,
    displayName: plan.meta.displayName,
    ownerId: plan.meta.ownerId,
    caption: plan.meta.caption,
    timestamp: plan.meta.timestamp,
    commentCount: plan.meta.commentCount,
    likeCount: plan.meta.likeCount,
    viewCount: plan.meta.viewCount,
    title: plan.meta.title,
    pageUrl: plan.meta.pageUrl || null,
    profilePostCount: plan.meta.profilePostCount || null,
    failedPostCount: plan.meta.failedPostCount || null,
    profileMediaFilter: plan.meta.profileMediaFilter || null,
    unfilteredItemCount: plan.meta.unfilteredItemCount || null,
    filteredItemCount: plan.meta.filteredItemCount || null,
    pagination: plan.meta.pagination || null,
    batchDiagnostics: plan.meta.batchDiagnostics || null,
    comments: plan.meta.comments || null,
    items: queuedDownloads.map((entry) => ({
      index: entry.item.index,
      mediaId: entry.item.mediaId,
      postId: entry.item.postId || null,
      type: entry.item.type,
      timestamp: entry.item.timestamp,
      expiresAt: entry.item.expiresAt,
      width: entry.item.width,
      height: entry.item.height,
      sourceUrl: entry.item.url,
      downloadFilename: entry.filename
    }))
  };
}

export function createBatchReportDocument(plan, result, settings) {
  return {
    generatedAt: new Date().toISOString(),
    pageKind: plan.meta.pageKind,
    id: plan.meta.id,
    username: plan.meta.username,
    pageUrl: plan.meta.pageUrl || null,
    source: plan.meta.source,
    duplicateMode: settings.duplicateMode,
    profileMediaFilter: settings.profileMediaFilter,
    summary: {
      requested: result.requested,
      downloaded: result.downloaded,
      skipped: result.skipped,
      failed: result.failed,
      metadataFilename: result.metadata?.filename || null
    },
    pagination: plan.meta.pagination || null,
    batchDiagnostics: plan.meta.batchDiagnostics || null,
    skippedItems: (result.skippedItems || []).map((entry) => ({
      filename: entry.filename,
      mediaId: entry.item?.mediaId || null,
      reason: entry.reason || null
    })),
    failures: (result.failures || []).map((entry) => ({
      filename: entry.filename,
      mediaId: entry.item?.mediaId || null,
      error: entry.error || null
    }))
  };
}

export async function enrichPlanMetadata(plan, tabUrl, settings) {
  // Comments are only written to the metadata sidecar, so skip the request when it is disabled.
  if (!settings.exportPostComments || !settings.saveMetadataSidecar) {
    return plan;
  }

  if (!["post", "reel", "reels", "tv"].includes(plan.meta.pageKind)) {
    return plan;
  }

  if (!plan.meta.postPk) {
    return plan;
  }

  try {
    const comments = await fetchPostComments(plan.meta.postPk, tabUrl);
    return {
      ...plan,
      meta: {
        ...plan.meta,
        comments
      }
    };
  } catch (err) {
    logWarn("post_comment_export_failed", {
      postPk: plan.meta.postPk,
      error: toErrorDetails(err)
    });
    return plan;
  }
}
