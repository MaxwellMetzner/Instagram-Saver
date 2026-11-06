import {
  getBulkJob,
  getBulkJobKey,
  getBulkScopeKey,
  getStoredJobKey,
  removeBulkJob,
  saveBulkJob,
  summarizeBulkJob
} from "./jobs.js";
import { buildRateLimitResumeAfter, isBulkCooldownActive, pauseForBulkStep } from "./pacing.js";
import {
  clearBulkJobActive,
  clearBulkJobStop,
  getBulkProgress,
  isBulkJobActive,
  isBulkJobStopRequested,
  markBulkJobActive,
  requestBulkJobStop,
  setBulkProgress
} from "./run-state.js";
import { InstagramResolverError, getErrorPresentation, isRateLimitError, toErrorDetails } from "../core/errors.js";
import { logError, logWarn } from "../core/logger.js";
import { mergeShortcodeQueues, uniqBy } from "../core/utils.js";
import { buildBatchReportFilename, ensureUniqueRelativePath } from "../downloads/filenames.js";
import { queueBatchReportDownload, queueDownloads } from "../downloads/queue.js";
import { extractInstagramPageData } from "../instagram/page-data.js";
import { resolvePostPlan } from "../instagram/posts.js";
import { fetchProfileInfo, fetchProfileTimelinePage, getInitialProfileTimeline } from "../instagram/profiles.js";
import { fetchSavedPostsPage } from "../instagram/saved.js";
import { parseInstagramUrl } from "../instagram/urls.js";
import { applyProfileMediaFilter, shouldReportProfileProgress } from "../plans/batch.js";
import { getSettings } from "../settings.js";
import { recordDownloadHistory } from "../storage/history.js";
import { BADGE_COLORS, clearBadgeSoon, setBadge } from "../ui/action.js";
import { sendToast } from "../ui/page-bridge.js";

// A bulk download works through a profile or saved feed in rounds of up to this many posts.
const BULK_BATCH_POST_LIMIT = 48;

const BULK_BATCH_PAGE_FETCH_LIMIT = 4;

async function createProfileBulkJob(user, tabUrl, settings, pageData = null) {
  const initialTimeline = pageData?.timeline?.shortcodes?.length
    ? {
      ...pageData.timeline,
      source: pageData.source
    }
    : await getInitialProfileTimeline(user, tabUrl, BULK_BATCH_POST_LIMIT);
  const profileUser = user?.user || user;
  const pendingShortcodes = initialTimeline.shortcodes;

  return {
    username: profileUser?.username || "instagram",
    jobKey: getBulkJobKey(profileUser?.username || "instagram"),
    scope: "profile",
    userId: String(profileUser?.id || profileUser?.pk || "") || null,
    pageUrl: tabUrl,
    title: profileUser?.full_name ? `${profileUser.full_name} (@${profileUser.username})` : `@${profileUser?.username || "instagram"}`,
    status: "paused",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    hasMore: Boolean(
      (profileUser?.id || profileUser?.pk) &&
      initialTimeline.hasNextPage &&
      initialTimeline.nextCursor
    ),
    nextCursor: initialTimeline.nextCursor || null,
    pendingShortcodes,
    profileMediaFilter: settings.profileMediaFilter,
    bulkPace: settings.bulkPace,
    duplicateMode: settings.duplicateMode,
    batchesCompleted: 0,
    totalPostsResolved: 0,
    totalFailedPosts: 0,
    totalMediaQueued: 0,
    totalMediaSkipped: 0,
    totalMediaFailed: 0,
    resumeAfter: null,
    rateLimitCount: 0,
    lastError: null,
    lastBatch: null
  };
}

async function createSavedBulkJob(descriptor, tabUrl, settings) {
  const initialTimeline = await fetchSavedPostsPage(
    descriptor.collectionId,
    null,
    tabUrl,
    BULK_BATCH_POST_LIMIT
  );
  const collectionName = descriptor.collectionName || (descriptor.collectionId ? "Saved collection" : "All saved posts");
  const title = `${collectionName} (@${descriptor.username})`;

  return {
    username: descriptor.username,
    jobKey: getBulkJobKey(getBulkScopeKey(descriptor)),
    scope: "saved",
    collectionId: descriptor.collectionId || null,
    pageUrl: tabUrl,
    title,
    status: "paused",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    hasMore: Boolean(initialTimeline.hasNextPage && initialTimeline.nextCursor),
    nextCursor: initialTimeline.nextCursor || null,
    pendingShortcodes: initialTimeline.shortcodes,
    profileMediaFilter: settings.profileMediaFilter,
    bulkPace: settings.bulkPace,
    duplicateMode: settings.duplicateMode,
    batchesCompleted: 0,
    totalPostsResolved: 0,
    totalFailedPosts: 0,
    totalMediaQueued: 0,
    totalMediaSkipped: 0,
    totalMediaFailed: 0,
    resumeAfter: null,
    rateLimitCount: 0,
    lastError: null,
    lastBatch: null
  };
}

async function collectBulkBatch(job, tabUrl, settings) {
  const selectedShortcodes = [];
  const pendingShortcodes = Array.isArray(job.pendingShortcodes) ? [...job.pendingShortcodes] : [];
  let nextCursor = job.nextCursor || null;
  let hasMore = Boolean(job.hasMore);
  let pagesFetched = 0;
  let stopReason = "bulk_completed";
  let rateLimitError = null;

  while (selectedShortcodes.length < BULK_BATCH_POST_LIMIT && pendingShortcodes.length > 0) {
    selectedShortcodes.push(pendingShortcodes.shift());
  }

  while (
    selectedShortcodes.length < BULK_BATCH_POST_LIMIT &&
    hasMore &&
    nextCursor &&
    pagesFetched < BULK_BATCH_PAGE_FETCH_LIMIT
  ) {
    try {
      await pauseForBulkStep(settings, "pageFetchDelayRangeMs");
      const page = job.scope === "saved"
        ? await fetchSavedPostsPage(job.collectionId, nextCursor, tabUrl)
        : await fetchProfileTimelinePage(job.userId, nextCursor, tabUrl);
      pagesFetched += 1;
      pendingShortcodes.push(...page.shortcodes);
      nextCursor = page.nextCursor;
      hasMore = page.hasNextPage;
    } catch (err) {
      if (!isRateLimitError(err)) {
        throw err;
      }

      rateLimitError = toErrorDetails(err);
      stopReason = "rate_limited";
      break;
    }

    while (selectedShortcodes.length < BULK_BATCH_POST_LIMIT && pendingShortcodes.length > 0) {
      selectedShortcodes.push(pendingShortcodes.shift());
    }
  }

  const hasPendingWork = pendingShortcodes.length > 0 || Boolean(hasMore && nextCursor);
  if (stopReason !== "rate_limited") {
    stopReason = hasPendingWork ? "batch_limit_reached" : "bulk_completed";
  }

  return {
    shortcodes: Array.from(new Set(selectedShortcodes)),
    pendingShortcodes,
    nextCursor,
    hasMore: hasPendingWork,
    pagesFetched,
    stopReason,
    rateLimitError
  };
}

async function resolveBulkBatchPlan(tabUrl, job, shortcodes, settings, progressCallback = null) {
  const aggregatedItems = [];
  const failedPosts = [];
  const remainingShortcodes = [];
  let rateLimitError = null;
  let stopRequested = false;

  for (let index = 0; index < shortcodes.length; index += 1) {
    if (isBulkJobStopRequested(getStoredJobKey(job))) {
      stopRequested = true;
      remainingShortcodes.push(...shortcodes.slice(index));
      break;
    }

    const shortcode = shortcodes[index];
    if (index > 0) {
      await pauseForBulkStep(settings, "postResolveDelayRangeMs");
    }

    if (progressCallback) {
      await progressCallback({
        current: index + 1,
        total: shortcodes.length,
        shortcode,
        shouldNotify: shouldReportProfileProgress(index + 1, shortcodes.length)
      });
    }

    try {
      const postPlan = await resolvePostPlan(`https://www.instagram.com/p/${shortcode}/`, {
        kind: "post",
        subtype: "post",
        shortcode
      });

      aggregatedItems.push(
        ...postPlan.items.map((item) => ({
          ...item,
          postId: postPlan.meta.id,
          postShortcode: postPlan.meta.id
        }))
      );
    } catch (err) {
      if (isRateLimitError(err)) {
        rateLimitError = toErrorDetails(err);
        remainingShortcodes.push(...shortcodes.slice(index));
        logWarn("bulk_post_resolution_rate_limited", {
          shortcode,
          error: rateLimitError
        });
        break;
      }

      failedPosts.push({
        shortcode,
        error: toErrorDetails(err)
      });
      logWarn("bulk_post_resolution_failed", {
        shortcode,
        error: toErrorDetails(err)
      });
    }
  }

  const processedPostCount = shortcodes.length - remainingShortcodes.length;
  const unfilteredItems = uniqBy(aggregatedItems, (item) => item.url);
  const filteredItems = applyProfileMediaFilter(unfilteredItems, settings.profileMediaFilter);

  return {
    meta: {
      id: job.username,
      username: job.username,
      displayName: job.title || `@${job.username}`,
      ownerId: job.userId || null,
      pageKind: job.scope === "saved" ? "saved" : "profile",
      title: job.title || `@${job.username}`,
      caption: null,
      pageUrl: job.pageUrl || tabUrl,
      timestamp: null,
      source: job.scope === "saved" ? "instagram_saved_bulk" : "instagram_profile_bulk",
      profilePostCount: processedPostCount,
      failedPostCount: failedPosts.length,
      profileMediaFilter: settings.profileMediaFilter,
      unfilteredItemCount: unfilteredItems.length,
      filteredItemCount: filteredItems.length,
      pagination: null
    },
    items: filteredItems,
    failedPosts,
    processedPostCount,
    remainingShortcodes,
    rateLimitError,
    stopRequested
  };
}

export async function getBulkJobStatus(tab) {
  const descriptor = parseInstagramUrl(tab?.url || "");
  if (!isBulkDescriptor(descriptor)) {
    return {
      ok: true,
      bulkJob: null
    };
  }

  const jobKey = getBulkScopeKey(descriptor);
  return {
    ok: true,
    bulkJob: summarizeLiveJob(jobKey, await getBulkJob(jobKey))
  };
}

export async function pauseBulkDownload(tab) {
  const tabUrl = tab?.url || "";
  const descriptor = parseInstagramUrl(tabUrl);
  if (!isBulkDescriptor(descriptor)) {
    throw new InstagramResolverError(
      "unsupported_url",
      "Open an Instagram profile or saved-posts page to pause its bulk download.",
      { tabUrl }
    );
  }

  const jobKey = getBulkScopeKey(descriptor);
  const job = await getBulkJob(jobKey);
  if (!job) {
    return {
      ok: true,
      paused: false,
      bulkJob: null
    };
  }

  const active = isBulkJobActive(jobKey);
  if (active) {
    requestBulkJobStop(jobKey);
  }

  const nextJob = {
    ...job,
    status: active ? "stopping" : job.status === "completed" ? "completed" : "paused",
    updatedAt: new Date().toISOString()
  };
  await saveBulkJob(nextJob);
  return {
    ok: true,
    paused: true,
    bulkJob: summarizeLiveJob(jobKey, nextJob)
  };
}

export async function resetBulkDownload(tab) {
  const tabUrl = tab?.url || "";
  const descriptor = parseInstagramUrl(tabUrl);
  if (!isBulkDescriptor(descriptor)) {
    throw new InstagramResolverError(
      "unsupported_url",
      "Open an Instagram profile or saved-posts page to start its bulk download over.",
      { tabUrl }
    );
  }

  const jobKey = getBulkScopeKey(descriptor);
  if (isBulkJobActive(jobKey)) {
    throw new InstagramResolverError(
      "bulk_download_running",
      "Pause the bulk download before starting over.",
      { tabUrl }
    );
  }

  await removeBulkJob(jobKey);
  return {
    ok: true,
    bulkJob: null
  };
}

function isBulkDescriptor(descriptor) {
  return descriptor.kind === "profile" || descriptor.kind === "saved";
}

function summarizeLiveJob(jobKey, job) {
  const isActive = isBulkJobActive(jobKey);
  const effectiveJob = job && isActive && isBulkJobStopRequested(jobKey)
    ? { ...job, status: "stopping" }
    : job;
  return summarizeBulkJob(effectiveJob, {
    isActive,
    progress: isActive ? getBulkProgress(jobKey) : null
  });
}

async function prepareBulkJob(tabId, tabUrl, descriptor, settings, existingJob) {
  let job = existingJob;
  if (!job || job.status === "completed") {
    if (descriptor.kind === "saved") {
      job = await createSavedBulkJob(descriptor, tabUrl, settings);
    } else {
      const pageData = await extractInstagramPageData(tabId, descriptor.username, BULK_BATCH_POST_LIMIT);
      const hasUsablePageData = Boolean(pageData?.user?.id || pageData?.user?.pk || pageData?.timeline?.shortcodes?.length);
      const profileInfo = hasUsablePageData
        ? { user: pageData.user, raw: null }
        : await fetchProfileInfo(descriptor.username, tabUrl);
      job = await createProfileBulkJob(profileInfo, tabUrl, settings, pageData);
    }
  }

  return {
    ...job,
    jobKey: getStoredJobKey(job),
    pageUrl: tabUrl,
    profileMediaFilter: settings.profileMediaFilter,
    bulkPace: settings.bulkPace,
    duplicateMode: settings.duplicateMode,
    resumeAfter: null,
    status: "running",
    updatedAt: new Date().toISOString(),
    lastError: null
  };
}

// Starts (or resumes) a bulk download and returns immediately; the work continues in the background.
export async function startBulkDownload(tab) {
  if (!tab?.id) {
    return { ok: false };
  }

  const tabId = tab.id;
  const tabUrl = tab.url || "";
  const descriptor = parseInstagramUrl(tabUrl);
  if (!isBulkDescriptor(descriptor)) {
    throw new InstagramResolverError(
      "unsupported_url",
      "Open an Instagram profile or saved-posts page to start a bulk download.",
      { tabUrl }
    );
  }

  const jobKey = getBulkScopeKey(descriptor);
  if (isBulkJobActive(jobKey)) {
    return {
      ok: true,
      alreadyRunning: true,
      bulkJob: summarizeLiveJob(jobKey, await getBulkJob(jobKey))
    };
  }

  const existingJob = await getBulkJob(jobKey);
  if (isBulkCooldownActive(existingJob)) {
    return {
      ok: true,
      rateLimited: true,
      deferred: true,
      bulkJob: summarizeLiveJob(jobKey, existingJob)
    };
  }

  // Mark active before any network work so a second click cannot start a duplicate run.
  markBulkJobActive(jobKey);
  clearBulkJobStop(jobKey);
  setBulkProgress(jobKey, { phase: "preparing", sessionDownloaded: 0, sessionSkipped: 0 });

  let job;
  let settings;
  try {
    settings = await getSettings();
    job = await prepareBulkJob(tabId, tabUrl, descriptor, settings, existingJob);
    await saveBulkJob(job);
  } catch (err) {
    clearBulkJobActive(jobKey);
    throw err;
  }

  const resumed = Number(job.batchesCompleted || 0) > 0;
  await setBadge(tabId, "BULK", BADGE_COLORS.working, `Bulk downloading ${job.title}`);
  await sendToast(tabId, `${resumed ? "Resuming" : "Starting"} bulk download for ${job.title}. You can close the popup; it keeps running.`, "info");

  runBulkLoop({ tabId, tabUrl, jobKey, job, settings }).catch((err) => {
    logError("bulk_download_loop_failed", err, { tabUrl, jobKey });
  });

  return {
    ok: true,
    started: true,
    bulkJob: summarizeLiveJob(jobKey, job)
  };
}

async function finishWithPause(context, job, lastBatch) {
  const { tabId, tabUrl } = context;
  const pausedJob = {
    ...job,
    status: "paused",
    updatedAt: new Date().toISOString(),
    resumeAfter: null,
    lastError: null,
    ...(lastBatch ? { lastBatch } : {})
  };
  await saveBulkJob(pausedJob);
  await setBadge(tabId, "⏸", BADGE_COLORS.error, `Bulk download paused for ${pausedJob.title}`);
  await sendToast(tabId, `Bulk download paused for ${pausedJob.title}. Resume any time to continue.`, "info");
  clearBadgeSoon(tabId, tabUrl, 2400);
}

async function announceCooldown(context, job) {
  const { tabId, tabUrl } = context;
  await setBadge(tabId, "WAIT", BADGE_COLORS.error, `Instagram asked to slow down for ${job.title}`);
  await sendToast(tabId, `Instagram asked us to slow down. The bulk download for ${job.title} is paused; resume it later and it will continue where it left off.`, "info");
  clearBadgeSoon(tabId, tabUrl, 2600);
}

async function announceCompletion(context, job) {
  const { tabId, tabUrl } = context;
  await setBadge(tabId, "OK", BADGE_COLORS.success, `Bulk download finished for ${job.title}`);
  await sendToast(tabId, `Bulk download finished for ${job.title}.`, "success");
  clearBadgeSoon(tabId, tabUrl);
}

async function downloadBatch(plan, settings) {
  if (!plan.items.length) {
    return {
      requested: 0,
      downloaded: 0,
      skipped: 0,
      failed: 0,
      failures: [],
      skippedItems: [],
      metadata: null,
      alreadyDownloaded: false,
      recordedKeys: [],
      plannedFilenames: []
    };
  }

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
      logWarn("bulk_batch_report_failed", {
        error: toErrorDetails(err)
      });
    }
  }

  await recordDownloadHistory(plan, result);
  return result;
}

async function runBulkLoop(context) {
  const { tabId, jobKey, settings, tabUrl } = context;
  let job = context.job;
  let sessionDownloaded = 0;
  let sessionSkipped = 0;

  try {
    while (true) {
      if (isBulkJobStopRequested(jobKey)) {
        await finishWithPause(context, job, {
          processedPosts: 0,
          resolvedMedia: 0,
          queued: 0,
          skipped: 0,
          failed: 0,
          pagesFetched: 0,
          stopReason: "stopped_by_user"
        });
        return;
      }

      const batchNumber = Number(job.batchesCompleted || 0) + 1;
      setBulkProgress(jobKey, { phase: "finding", batchNumber, current: 0, total: 0 });
      const batch = await collectBulkBatch(job, tabUrl, settings);
      const batchPausedForRateLimit = batch.stopReason === "rate_limited";

      if (!batch.shortcodes.length) {
        const now = new Date().toISOString();
        job = {
          ...job,
          pendingShortcodes: batch.pendingShortcodes,
          nextCursor: batch.nextCursor,
          hasMore: batch.hasMore,
          status: batchPausedForRateLimit ? "rate_limited" : "completed",
          updatedAt: now,
          completedAt: batchPausedForRateLimit ? null : now,
          resumeAfter: batchPausedForRateLimit
            ? buildRateLimitResumeAfter(batch.rateLimitError, settings)
            : null,
          rateLimitCount: Number(job.rateLimitCount || 0) + (batchPausedForRateLimit ? 1 : 0),
          lastError: batch.rateLimitError?.message || null,
          lastBatch: {
            processedPosts: 0,
            resolvedMedia: 0,
            queued: 0,
            skipped: 0,
            failed: 0,
            pagesFetched: batch.pagesFetched,
            stopReason: batch.stopReason
          }
        };
        await saveBulkJob(job);

        if (batchPausedForRateLimit) {
          await announceCooldown(context, job);
        } else {
          await announceCompletion(context, job);
        }
        return;
      }

      setBulkProgress(jobKey, { phase: "reading", batchNumber, current: 0, total: batch.shortcodes.length });
      const batchPlanResult = await resolveBulkBatchPlan(tabUrl, job, batch.shortcodes, settings, async (progress) => {
        setBulkProgress(jobKey, { phase: "reading", batchNumber, current: progress.current, total: progress.total });
        await setBadge(tabId, `${progress.current}/${progress.total}`, BADGE_COLORS.working, `Bulk downloading @${job.username}: post ${progress.current} of ${progress.total} in this round`);
        if (progress.shouldNotify) {
          await sendToast(tabId, `Bulk download @${job.username}: reading post ${progress.current} of ${progress.total} in round ${batchNumber}...`, "info");
        }
      });

      const processedPostCount = Number(batchPlanResult.processedPostCount || 0);
      const resolutionPausedForRateLimit = Boolean(batchPlanResult.rateLimitError);
      const stoppedByUser = Boolean(batchPlanResult.stopRequested);
      const pausedForRateLimit = batchPausedForRateLimit || resolutionPausedForRateLimit;
      const preservedShortcodes = resolutionPausedForRateLimit || stoppedByUser
        ? mergeShortcodeQueues(batchPlanResult.remainingShortcodes, batch.pendingShortcodes)
        : batch.pendingShortcodes;
      const hasSavedWork = preservedShortcodes.length > 0 || Boolean(batch.hasMore && batch.nextCursor);
      const contentLabel = job.scope === "saved" ? "saved post" : "post";

      const plan = {
        ...batchPlanResult,
        meta: {
          ...batchPlanResult.meta,
          batchDiagnostics: [
            `Read ${processedPostCount} ${contentLabel}${processedPostCount === 1 ? "" : "s"} in round ${batchNumber} of this bulk download.`,
            pausedForRateLimit
              ? "Instagram asked us to slow down. Resume later to continue where this round stopped."
              : stoppedByUser
                ? "Paused from the popup. Resume later to continue."
                : hasSavedWork
                  ? "Continuing automatically with older posts."
                  : "Reached the oldest post."
          ]
        }
      };

      setBulkProgress(jobKey, { phase: "saving", batchNumber, current: processedPostCount, total: batch.shortcodes.length });
      const result = await downloadBatch(plan, settings);
      sessionDownloaded += Number(result.downloaded || 0);
      sessionSkipped += Number(result.skipped || 0);
      setBulkProgress(jobKey, { sessionDownloaded, sessionSkipped });

      const now = new Date().toISOString();
      const rateLimitError = batchPlanResult.rateLimitError || batch.rateLimitError || null;
      job = {
        ...job,
        pendingShortcodes: preservedShortcodes,
        nextCursor: batch.nextCursor,
        hasMore: hasSavedWork,
        status: pausedForRateLimit ? "rate_limited" : stoppedByUser ? "paused" : hasSavedWork ? "running" : "completed",
        updatedAt: now,
        completedAt: pausedForRateLimit || stoppedByUser || hasSavedWork ? null : now,
        resumeAfter: pausedForRateLimit && !stoppedByUser
          ? buildRateLimitResumeAfter(rateLimitError, settings)
          : null,
        rateLimitCount: Number(job.rateLimitCount || 0) + (pausedForRateLimit ? 1 : 0),
        batchesCompleted: Number(job.batchesCompleted || 0) + 1,
        totalPostsResolved: Number(job.totalPostsResolved || 0) + processedPostCount,
        totalFailedPosts: Number(job.totalFailedPosts || 0) + Number(batchPlanResult.failedPosts?.length || 0),
        totalMediaQueued: Number(job.totalMediaQueued || 0) + Number(result.downloaded || 0),
        totalMediaSkipped: Number(job.totalMediaSkipped || 0) + Number(result.skipped || 0),
        totalMediaFailed: Number(job.totalMediaFailed || 0) + Number(result.failed || 0),
        lastError: pausedForRateLimit
          ? rateLimitError?.message || "Instagram asked us to slow down."
          : null,
        lastBatch: {
          processedPosts: processedPostCount,
          resolvedMedia: plan.items.length,
          queued: result.downloaded || 0,
          skipped: result.skipped || 0,
          failed: result.failed || 0,
          pagesFetched: batch.pagesFetched,
          stopReason: pausedForRateLimit
            ? "rate_limited"
            : stoppedByUser
              ? "stopped_by_user"
              : hasSavedWork
                ? "batch_limit_reached"
                : "bulk_completed"
        }
      };
      await saveBulkJob(job);

      if (pausedForRateLimit) {
        await announceCooldown(context, job);
        return;
      }

      if (stoppedByUser) {
        await finishWithPause(context, job, null);
        return;
      }

      if (!hasSavedWork) {
        await announceCompletion(context, job);
        return;
      }

      setBulkProgress(jobKey, { phase: "waiting", batchNumber, current: 0, total: 0 });
      await pauseForBulkStep(settings, "batchDelayRangeMs");
    }
  } catch (err) {
    const presentation = getErrorPresentation(err);
    job = {
      ...job,
      status: "error",
      updatedAt: new Date().toISOString(),
      lastError: toErrorDetails(err).message
    };
    await saveBulkJob(job);
    logWarn("bulk_download_failed", {
      tabUrl,
      jobKey,
      error: presentation
    });
    await setBadge(tabId, "ERR", BADGE_COLORS.error, presentation.title);
    await sendToast(tabId, `Bulk download stopped: ${presentation.title}. Resume to try again.`, "error");
    clearBadgeSoon(tabId, tabUrl, 6000);
  } finally {
    clearBulkJobActive(jobKey);
    clearBulkJobStop(jobKey);
  }
}
