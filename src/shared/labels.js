// User-facing wording shared by the service worker, popup, and options page.

export function pluralize(count, singular, plural = `${singular}s`) {
  const value = Number(count || 0);
  return `${value} ${value === 1 ? singular : plural}`;
}

export const PAGE_KIND_LABELS = Object.freeze({
  post: "Post",
  reel: "Reel",
  story: "Story",
  highlight: "Highlight",
  profile: "Profile",
  saved: "Saved posts",
  unsupported: "Not supported"
});

// What a single item inside each page kind is called ("slide 2 of 5", "frame 3 of 9").
export const ITEM_NOUNS = Object.freeze({
  post: "slide",
  reel: "video",
  story: "story",
  highlight: "frame",
  profile: "post",
  saved: "post"
});

const ITEM_NOUN_PLURALS = Object.freeze({
  slide: "slides",
  video: "videos",
  story: "stories",
  frame: "frames",
  post: "posts",
  item: "items"
});

export const BULK_PACE_LABELS = Object.freeze({
  safer: "Gentle",
  balanced: "Balanced",
  aggressive: "Fast"
});

export const BULK_PACE_DESCRIPTIONS = Object.freeze({
  safer: "Longest pauses between requests. Least likely to hit Instagram limits.",
  balanced: "Moderate pauses. A good middle ground for large accounts.",
  aggressive: "Shortest pauses. Quickest, but more likely to need a cool-down."
});

export const MEDIA_FILTER_LABELS = Object.freeze({
  all: "Photos & videos",
  images: "Photos only",
  videos: "Videos only"
});

export function formatPageKind(pageKind) {
  return PAGE_KIND_LABELS[pageKind] || "Instagram";
}

export function formatItemNoun(pageKind, count = 1) {
  const noun = ITEM_NOUNS[pageKind] || "item";
  return Number(count) === 1 ? noun : ITEM_NOUN_PLURALS[noun];
}

export function formatBulkPace(bulkPace) {
  return BULK_PACE_LABELS[bulkPace === "faster" ? "aggressive" : bulkPace] || BULK_PACE_LABELS.aggressive;
}

export function formatMediaFilter(profileMediaFilter) {
  return MEDIA_FILTER_LABELS[profileMediaFilter] || MEDIA_FILTER_LABELS.all;
}

export function formatTime(isoString) {
  if (!isoString) return "";
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export const BULK_STATUS_LABELS = Object.freeze({
  idle: "Not started",
  running: "Downloading",
  stopping: "Pausing",
  paused: "Paused",
  rate_limited: "Cooling down",
  completed: "Finished",
  error: "Stopped"
});

export function describeBulkJob(job) {
  if (!job) {
    return {
      status: "idle",
      label: BULK_STATUS_LABELS.idle,
      tone: "neutral",
      detail: "Nothing downloaded yet. Progress is saved automatically, so you can pause and resume at any time."
    };
  }

  const status = BULK_STATUS_LABELS[job.status] ? job.status : "paused";
  const contentLabel = job.scope === "saved" ? "saved post" : "post";
  const files = pluralize(job.totalMediaQueued, "file");
  const posts = pluralize(job.totalPostsResolved, contentLabel);
  let detail;
  let tone = "neutral";

  if (status === "running") {
    tone = "working";
    detail = `${files} downloaded from ${posts} so far.`;
  } else if (status === "stopping") {
    tone = "working";
    detail = "Finishing the current post, then pausing. Your progress is kept.";
  } else if (status === "rate_limited") {
    tone = "warning";
    const resumeAt = formatTime(job.resumeAfter);
    detail = resumeAt
      ? `Instagram asked us to slow down. You can resume after ${resumeAt}; nothing will be downloaded twice.`
      : "Instagram asked us to slow down. Wait a few minutes, then resume; nothing will be downloaded twice.";
  } else if (status === "completed") {
    tone = "success";
    detail = `All done: ${files} downloaded from ${posts}.`;
  } else if (status === "error") {
    tone = "error";
    detail = `${job.lastError || "Something went wrong."} Resume to try again from where it stopped.`;
  } else {
    detail = job.interrupted
      ? `Interrupted after ${files} from ${posts}. Resume to continue where it left off.`
      : `${files} downloaded from ${posts}. Resume to continue where it left off.`;
  }

  return { status, label: BULK_STATUS_LABELS[status], tone, detail };
}

export const DOWNLOAD_SOURCE_LABELS = Object.freeze({
  instagram_profile_bulk: "Bulk download",
  instagram_saved_bulk: "Bulk download",
  instagram_profile_full_crawl: "Bulk download",
  instagram_saved_full_crawl: "Bulk download"
});

export function describeHistoryEntry(entry) {
  const kind = formatPageKind(entry?.pageKind);
  const bulk = Boolean(DOWNLOAD_SOURCE_LABELS[entry?.source]);
  let scope;

  if (entry?.scope === "current") {
    const noun = formatItemNoun(entry.pageKind);
    scope = entry.position && entry.total
      ? `${noun.charAt(0).toUpperCase()}${noun.slice(1)} ${entry.position} of ${entry.total}`
      : `Single ${noun}`;
  } else if (bulk) {
    scope = "Bulk download";
  } else if (entry?.pageKind === "profile" || entry?.pageKind === "saved") {
    scope = "Quick download";
  } else {
    scope = "Everything";
  }

  return { kind, scope, bulk };
}
