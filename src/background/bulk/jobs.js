import { normalizeBulkPace } from "../../shared/settings.js";
import { describeBulkJob } from "../../shared/labels.js";
import { getDownloadState, saveDownloadState } from "../storage/history.js";

export function getBulkJobKey(username) {
  return String(username || "").trim().toLowerCase();
}

export function getBulkScopeKey(descriptor) {
  if (descriptor.kind === "saved") {
    const collection = descriptor.collectionId ? `collection:${descriptor.collectionId}` : "all";
    return `saved:${descriptor.username}:${collection}`;
  }

  return descriptor.username;
}

// Older saved jobs used "crawlKey"; new jobs store "jobKey".
export function getStoredJobKey(job) {
  return getBulkJobKey(job?.jobKey || job?.crawlKey || job?.username);
}

export async function getBulkJob(username) {
  if (!username) return null;
  const state = await getDownloadState();
  return state.bulkJobs[getBulkJobKey(username)] || null;
}

export async function saveBulkJob(job) {
  const state = await getDownloadState();
  const bulkJobs = {
    ...state.bulkJobs,
    [getStoredJobKey(job)]: job
  };
  await saveDownloadState(state.downloadHistory, state.downloadedMediaKeys, bulkJobs);
  return job;
}

export async function removeBulkJob(username) {
  const state = await getDownloadState();
  const bulkJobs = { ...state.bulkJobs };
  delete bulkJobs[getBulkJobKey(username)];
  await saveDownloadState(state.downloadHistory, state.downloadedMediaKeys, bulkJobs);
}

export function summarizeBulkJob(job, { isActive = false, progress = null } = {}) {
  if (!job) return null;

  // A job left "running" in storage without an active loop was interrupted (e.g. the browser closed).
  const interrupted = !isActive && (job.status === "running" || job.status === "stopping");
  const status = interrupted ? "paused" : job.status || "paused";
  const summary = {
    key: getStoredJobKey(job),
    username: job.username,
    title: job.title,
    scope: job.scope === "saved" ? "saved" : "profile",
    status,
    isActive: Boolean(isActive),
    interrupted,
    batchesCompleted: Number(job.batchesCompleted || 0),
    totalPostsResolved: Number(job.totalPostsResolved || 0),
    totalFailedPosts: Number(job.totalFailedPosts || 0),
    totalMediaQueued: Number(job.totalMediaQueued || 0),
    totalMediaSkipped: Number(job.totalMediaSkipped || 0),
    totalMediaFailed: Number(job.totalMediaFailed || 0),
    hasMore: Boolean(job.hasMore),
    pendingPosts: Array.isArray(job.pendingShortcodes) ? job.pendingShortcodes.length : 0,
    profileMediaFilter: job.profileMediaFilter || "all",
    bulkPace: normalizeBulkPace(job.bulkPace ?? job.fullCrawlPace),
    duplicateMode: job.duplicateMode || "history",
    resumeAfter: job.resumeAfter || null,
    rateLimitCount: Number(job.rateLimitCount || 0),
    createdAt: job.createdAt || null,
    updatedAt: job.updatedAt || null,
    completedAt: job.completedAt || null,
    lastError: job.lastError || null,
    lastBatch: job.lastBatch || null,
    progress: isActive ? progress : null
  };

  return {
    ...summary,
    statusLine: describeBulkJob(summary).detail
  };
}
