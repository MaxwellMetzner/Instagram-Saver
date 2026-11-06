// Pure helpers that turn preview/bulk data into popup wording. No DOM access, so they can be unit tested.
import {
  describeBulkJob,
  formatBulkPace,
  formatItemNoun,
  formatMediaFilter,
  formatPageKind,
  formatTime,
  pluralize
} from "../shared/labels.js";

const MULTI_ITEM_KINDS = new Set(["post", "story", "highlight"]);
const BULK_KINDS = new Set(["profile", "saved"]);

function capitalize(text) {
  const value = String(text || "");
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function describeMediaMix(imageCount, videoCount) {
  const parts = [];
  if (imageCount) parts.push(pluralize(imageCount, "photo"));
  if (videoCount) parts.push(pluralize(videoCount, "video"));
  return parts.join(", ") || "No media";
}

export function isBulkPage(pageKind) {
  return BULK_KINDS.has(pageKind);
}

export function describePage(preview) {
  const summary = preview?.summary || {};
  const owner = summary.username ? `@${summary.username}` : "Instagram";
  let title = preview?.meta?.title || summary.title || "";

  if (isBulkPage(summary.pageKind)) {
    title = `Showing the newest ${pluralize(summary.maxProfilePosts, summary.pageKind === "saved" ? "saved post" : "post")}`;
  }

  return {
    kindLabel: formatPageKind(summary.pageKind),
    owner,
    title,
    showDuplicates: summary.duplicateMode !== "none"
  };
}

/**
 * Builds the two download choices for posts, reels, stories, and highlights.
 * `defaultScope` decides which button is emphasised.
 */
export function describeSingleChoices(preview, defaultScope = "all") {
  const summary = preview?.summary || {};
  const total = Number(summary.totalCount || 0);
  const noun = formatItemNoun(summary.pageKind);
  const allDetail = describeMediaMix(summary.imageCount, summary.videoCount);

  if (total <= 1 || !MULTI_ITEM_KINDS.has(summary.pageKind)) {
    const onlyType = summary.videoCount && !summary.imageCount ? "video" : summary.imageCount && !summary.videoCount ? "photo" : "media";
    return {
      showCurrent: false,
      primary: "all",
      all: {
        title: total <= 1 ? `Download this ${onlyType}` : `Download all ${total} files`,
        detail: allDetail
      },
      current: null,
      note: ""
    };
  }

  const current = preview?.current || null;
  const known = Number.isInteger(current?.index);
  let detail;
  let note = "";

  if (known) {
    const typeLabel = current.type === "video" ? "video" : "photo";
    detail = `${capitalize(noun)} ${current.position} of ${total} · ${typeLabel}${current.alreadyDownloaded ? " · already saved" : ""}`;
    if (current.method === "assumed") {
      note = `Couldn't confirm which ${noun} is showing, so this assumes the first one. Swipe to the ${noun} you want and press refresh if that's wrong.`;
    }
  } else {
    detail = `Checks which ${noun} is on screen when you click`;
    note = `Couldn't see which ${noun} is on screen yet. Make sure it's visible, then press refresh.`;
  }

  return {
    showCurrent: true,
    primary: defaultScope === "current" ? "current" : "all",
    current: {
      title: `This ${noun} only`,
      detail
    },
    all: {
      title: `All ${total} ${formatItemNoun(summary.pageKind, total)}`,
      detail: allDetail
    },
    note
  };
}

export function describeQuickDownload(preview) {
  const summary = preview?.summary || {};
  const saved = summary.pageKind === "saved";
  const posts = pluralize(summary.maxProfilePosts, saved ? "saved post" : "post");
  const total = Number(summary.totalCount || 0);

  return {
    description: `Saves the newest ${posts} (${formatMediaFilter(summary.profileMediaFilter).toLowerCase()}) right now. Change how many in Settings.`,
    buttonLabel: total ? `Download ${pluralize(total, "file")}` : "Nothing to download",
    disabled: total === 0
  };
}

function cooldownEndsAt(job) {
  const timestamp = new Date(job?.resumeAfter || "").getTime();
  return Number.isFinite(timestamp) && timestamp > Date.now() ? timestamp : null;
}

function describeProgress(job) {
  const progress = job?.progress;
  if (!job?.isActive || !progress) {
    return null;
  }

  const round = progress.batchNumber ? ` (round ${progress.batchNumber})` : "";
  const session = progress.sessionDownloaded || progress.sessionSkipped
    ? ` · This run: ${pluralize(progress.sessionDownloaded, "file")} saved${progress.sessionSkipped ? `, ${progress.sessionSkipped} skipped` : ""}`
    : "";

  switch (progress.phase) {
    case "reading": {
      const total = Number(progress.total || 0);
      const current = Number(progress.current || 0);
      return {
        percent: total ? Math.min(100, Math.round((current / total) * 100)) : null,
        text: `Reading post ${current} of ${total}${round}${session}`
      };
    }
    case "saving":
      return { percent: 100, text: `Saving files${round}${session}` };
    case "finding":
      return { percent: null, text: `Finding more posts${round}${session}` };
    case "waiting":
      return { percent: null, text: `Short break so Instagram doesn't block us${session}` };
    default:
      return { percent: null, text: `Getting ready${session}` };
  }
}

/**
 * Describes the bulk download card for a profile or saved-posts page.
 * `settings` supplies the speed/media filter shown before a job exists.
 */
export function describeBulk(pageKind, job, settings = {}) {
  const saved = pageKind === "saved";
  const state = describeBulkJob(job);
  const cooldown = cooldownEndsAt(job);
  const explainer = saved
    ? "Goes through all of your saved posts, newest to oldest, and downloads them in the background. Progress is saved, so you can pause, close this popup, and pick up later."
    : "Goes through every post on this profile, newest to oldest, and downloads them in the background. Progress is saved, so you can pause, close this popup, and pick up later.";

  let primary = { label: "Start bulk download", action: "start", disabled: false };
  if (state.status === "running") {
    primary = { label: "Pause", action: "pause", disabled: false };
  } else if (state.status === "stopping") {
    primary = { label: "Pausing…", action: "pause", disabled: true };
  } else if (state.status === "rate_limited" && cooldown) {
    primary = { label: `Resume after ${formatTime(new Date(cooldown).toISOString())}`, action: "start", disabled: true };
  } else if (state.status === "completed") {
    primary = {
      label: (job?.duplicateMode || settings.duplicateMode) === "none" ? "Run again" : "Check for new posts",
      action: "start",
      disabled: false
    };
  } else if (job) {
    primary = { label: "Resume", action: "start", disabled: false };
  }

  const pace = job?.bulkPace || settings.bulkPace;
  const filter = job?.profileMediaFilter || settings.profileMediaFilter;

  return {
    explainer,
    chip: { label: state.label, tone: state.tone },
    detail: job ? state.detail : "",
    stats: job
      ? {
        posts: Number(job.totalPostsResolved || 0),
        files: Number(job.totalMediaQueued || 0),
        skipped: Number(job.totalMediaSkipped || 0)
      }
      : null,
    progress: describeProgress(job),
    primary,
    showReset: Boolean(job) && !job.isActive,
    settingsHint: `Speed: ${formatBulkPace(pace)} · ${formatMediaFilter(filter)}`,
    isActive: Boolean(job?.isActive)
  };
}

export function describeDownloadResult(response) {
  const result = response?.result || {};
  const currentItem = response?.currentItem;

  if (result.alreadyDownloaded) {
    return result.requested === 1 ? "You already have this file." : "You already have all of these files.";
  }

  const skipped = result.skipped ? ` Skipped ${pluralize(result.skipped, "file")} you already have.` : "";
  if (currentItem) {
    const noun = formatItemNoun(response?.preview?.summary?.pageKind);
    return `Saving ${noun} ${currentItem.position} of ${currentItem.total}.${skipped}`;
  }

  if (!result.downloaded) {
    return `Nothing new to download.${skipped}`;
  }

  return `Saving ${pluralize(result.downloaded, "file")}.${skipped}`;
}

export function describeDuplicates(summary) {
  if (summary?.duplicateMode === "none") {
    return "Off: files are downloaded again even if you already have them.";
  }

  return summary?.duplicateCount
    ? `${pluralize(summary.duplicateCount, "file")} already downloaded and will be skipped.`
    : "None of these have been downloaded before.";
}

export function formatErrorRequest(error) {
  const requestUrl = error?.context?.url;
  if (!requestUrl) {
    return "";
  }

  let endpoint;
  try {
    const parsedUrl = new URL(requestUrl);
    endpoint = `${parsedUrl.origin}${parsedUrl.pathname}`;
  } catch {
    return "";
  }

  const status = Number(error?.context?.status || 0);
  const requestLabel = error?.context?.requestLabel;
  const durationMs = Number(error?.context?.durationMs || 0);
  const details = [
    status > 0 ? `HTTP ${status}` : "",
    requestLabel ? `attempt ${requestLabel}` : "",
    durationMs > 0 ? `${durationMs}ms` : ""
  ].filter(Boolean).join(" • ");
  if (!details) {
    return `Failed request: ${endpoint}`;
  }

  return status > 0
    ? `Failed request: ${details} from ${endpoint}`
    : `Failed request: ${details} at ${endpoint}`;
}
