const MENU_ID_PAGE = "save-instagram-page-media";
const LOG_PREFIX = "[InstagramSaver]";
const INSTAGRAM_SHORTCODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const INSTAGRAM_GRAPHQL_DOC_ID = "8845758582119845";
const DEFAULT_ACTION_TITLE = "Download media from the current Instagram page";
const DEFAULT_POPUP_PATH = "popup.html";
const BADGE_REFRESH_DELAY_MS = 350;
const PREVIEW_CACHE_TTL_MS = 15000;
const BADGE_COLORS = {
  working: "#1D4ED8",
  success: "#15803D",
  error: "#B91C1C"
};
const badgeRefreshTimers = new Map();
const previewCache = new Map();
const DOWNLOAD_HISTORY_LIMIT = 20;
const DOWNLOADED_MEDIA_KEY_LIMIT = 4000;
const FULL_PROFILE_CRAWL_POST_BATCH_LIMIT = 48;
const FULL_PROFILE_CRAWL_PAGE_FETCH_LIMIT = 4;
const DEFAULT_SETTINGS = {
  easyMode: false,
  confirmBeforeDownload: true,
  saveMetadataSidecar: true,
  placeMetadataInSubfolder: false,
  exportBatchReport: false,
  exportPostComments: false,
  promptForSingleDownload: true,
  duplicateMode: "history",
  skipExistingDownloads: true,
  maxProfilePosts: 24,
  profileMediaFilter: "all",
  folderTemplate: "instagram/{username}",
  filenameTemplate: "{username}_{id}_{index}",
  metadataFilenameTemplate: "{username}_{id}_metadata"
};

class InstagramResolverError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = "InstagramResolverError";
    this.code = code;
    this.context = context;
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: MENU_ID_PAGE,
    title: "Save media from this Instagram page",
    contexts: ["page"],
    documentUrlPatterns: ["https://*.instagram.com/*"]
  });

  await syncActionPresentation();
});

function logInfo(event, context = {}) {
  console.info(`${LOG_PREFIX} ${event}`, context);
}

function logWarn(event, context = {}) {
  console.warn(`${LOG_PREFIX} ${event}`, context);
}

function logError(event, err, context = {}) {
  try {
    console.error(`${LOG_PREFIX} ${event}`, {
      ...context,
      error: toErrorDetails(err)
    });
  } catch (loggingError) {
    console.error(`${LOG_PREFIX} ${event}`, {
      message: String(err?.message || err || "Unknown error"),
      loggingError: String(loggingError?.message || loggingError || "Logging failed")
    });
  }
}

function toErrorDetails(err) {
  if (!err) {
    return { message: "Unknown error" };
  }

  if (err instanceof InstagramResolverError) {
    return {
      message: err.message,
      code: err.code,
      context: err.context
    };
  }

  if (err instanceof Error) {
    return {
      message: err.message,
      stack: err.stack
    };
  }

  return {
    message: String(err)
  };
}

function summarizeTimelineConnection(connection) {
  const edges = Array.isArray(connection?.edges) ? connection.edges : [];
  return {
    edgeCount: edges.length,
    hasNextPage: Boolean(connection?.page_info?.has_next_page),
    hasCursor: Boolean(connection?.page_info?.end_cursor)
  };
}

function isInstagramUrl(url) {
  try {
    const host = new URL(url || "").hostname.toLowerCase();
    return host === "instagram.com" || host.endsWith(".instagram.com");
  } catch {
    return false;
  }
}

function sanitizeFilenamePart(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

function applyTemplate(template, context, fallback) {
  const rendered = String(template || fallback || "")
    .replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key) => sanitizeFilenamePart(context[key] ?? ""))
    .replace(/_+/g, "_")
    .replace(/\/+/g, "/")
    .trim();

  return rendered || fallback;
}

function guessExtension(url, mediaType) {
  try {
    const parsed = new URL(url);
    const stp = (parsed.searchParams.get("stp") || "").toLowerCase();

    if (stp.includes("dst-jpg")) return "jpg";
    if (stp.includes("dst-webp")) return "webp";
    if (stp.includes("dst-png")) return "png";

    const fileName = parsed.pathname.split("/").pop() || "";
    const extensionMatch = fileName.match(/\.([a-z0-9]+)$/i);
    if (extensionMatch) {
      return extensionMatch[1].toLowerCase();
    }
  } catch {
    // ignore URL parsing issues
  }

  return mediaType === "video" ? "mp4" : "jpg";
}

function normalizeUrl(url) {
  if (!url) return null;

  try {
    return new URL(url).href;
  } catch {
    return null;
  }
}

function getLargestImageCandidateUrl(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  const sorted = [...candidates].sort((left, right) => {
    const leftPixels = Number(left?.width || 0) * Number(left?.height || 0);
    const rightPixels = Number(right?.width || 0) * Number(right?.height || 0);
    return rightPixels - leftPixels;
  });

  return normalizeUrl(sorted[0]?.url);
}

function getLargestVideoVersion(videoVersions) {
  if (!Array.isArray(videoVersions) || videoVersions.length === 0) return null;

  const sorted = [...videoVersions].sort((left, right) => {
    const leftPixels = Number(left?.width || 0) * Number(left?.height || 0);
    const rightPixels = Number(right?.width || 0) * Number(right?.height || 0);
    return rightPixels - leftPixels;
  });

  return sorted[0] || null;
}

function uniqBy(items, getKey) {
  const result = [];
  const seen = new Set();

  for (const item of items || []) {
    const key = getKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }

  return result;
}

function extractShortcodeFromUrl(url) {
  const match = String(url || "").match(/\/(?:p|reel|reels|tv)\/([^/?#&]+)/i);
  return match?.[1] || null;
}

function instagramShortcodeToPk(shortcode) {
  if (!shortcode) return null;

  let clean = String(shortcode).trim();
  if (clean.length > 28) {
    clean = clean.slice(0, clean.length - 28);
  }

  if (!clean) return null;

  let value = 0n;
  for (const char of clean) {
    const digit = INSTAGRAM_SHORTCODE_CHARS.indexOf(char);
    if (digit < 0) return null;
    value = value * 64n + BigInt(digit);
  }

  return value.toString(10);
}

function getInstagramApiHeaders(refererUrl) {
  return {
    "X-IG-App-ID": "936619743392459",
    "X-ASBD-ID": "198387",
    "X-IG-WWW-Claim": "0",
    "X-Requested-With": "XMLHttpRequest",
    Origin: "https://www.instagram.com",
    Referer: refererUrl || "https://www.instagram.com/",
    Accept: "*/*"
  };
}

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const duplicateMode = ["history", "none"].includes(stored.duplicateMode)
    ? stored.duplicateMode
    : stored.skipExistingDownloads === false
      ? "none"
      : "history";
  const profileMediaFilter = ["all", "images", "videos"].includes(stored.profileMediaFilter)
    ? stored.profileMediaFilter
    : "all";

  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    duplicateMode,
    skipExistingDownloads: duplicateMode === "history",
    profileMediaFilter,
    maxProfilePosts: Math.max(1, Number(stored.maxProfilePosts || DEFAULT_SETTINGS.maxProfilePosts) || DEFAULT_SETTINGS.maxProfilePosts)
  };
}

async function getDownloadState() {
  const stored = await chrome.storage.local.get({
    downloadHistory: [],
    downloadedMediaKeys: [],
    crawlJobs: {}
  });

  return {
    downloadHistory: Array.isArray(stored.downloadHistory) ? stored.downloadHistory : [],
    downloadedMediaKeys: Array.isArray(stored.downloadedMediaKeys) ? stored.downloadedMediaKeys : [],
    crawlJobs: stored.crawlJobs && typeof stored.crawlJobs === "object" ? stored.crawlJobs : {}
  };
}

function buildDownloadKey(item) {
  return String(item?.mediaId || item?.postId || item?.url || "");
}

async function getKnownDownloadKeys() {
  const state = await getDownloadState();
  return new Set(state.downloadedMediaKeys.filter(Boolean));
}

async function saveDownloadState(downloadHistory, downloadedMediaKeys, crawlJobs = {}) {
  await chrome.storage.local.set({
    downloadHistory: downloadHistory.slice(0, DOWNLOAD_HISTORY_LIMIT),
    downloadedMediaKeys: downloadedMediaKeys.slice(-DOWNLOADED_MEDIA_KEY_LIMIT),
    crawlJobs
  });
}

async function recordDownloadHistory(plan, result) {
  const state = await getDownloadState();
  const historyEntry = {
    recordedAt: new Date().toISOString(),
    id: plan.meta.id,
    username: plan.meta.username,
    pageKind: plan.meta.pageKind,
    source: plan.meta.source,
    requested: result.requested,
    downloaded: result.downloaded,
    skipped: result.skipped,
    failed: result.failed,
    metadataFilename: result.metadata?.filename || null,
    reportFilename: result.report?.filename || null
  };

  const nextHistory = [historyEntry, ...state.downloadHistory].slice(0, DOWNLOAD_HISTORY_LIMIT);
  const nextKeys = [...state.downloadedMediaKeys, ...result.recordedKeys].slice(-DOWNLOADED_MEDIA_KEY_LIMIT);
  await saveDownloadState(nextHistory, nextKeys, state.crawlJobs);
}

function getCrawlJobKey(username) {
  return String(username || "").trim().toLowerCase();
}

async function getCrawlJob(username) {
  if (!username) return null;
  const state = await getDownloadState();
  return state.crawlJobs[getCrawlJobKey(username)] || null;
}

async function saveCrawlJob(job) {
  const state = await getDownloadState();
  const crawlJobs = {
    ...state.crawlJobs,
    [getCrawlJobKey(job.username)]: job
  };
  await saveDownloadState(state.downloadHistory, state.downloadedMediaKeys, crawlJobs);
  return job;
}

async function removeCrawlJob(username) {
  const state = await getDownloadState();
  const crawlJobs = { ...state.crawlJobs };
  delete crawlJobs[getCrawlJobKey(username)];
  await saveDownloadState(state.downloadHistory, state.downloadedMediaKeys, crawlJobs);
}

function summarizeCrawlJob(job) {
  if (!job) return null;

  const moreText = job.hasMore ? "More profile pages remain." : "Profile crawl is at the end of pagination.";
  return {
    username: job.username,
    title: job.title,
    status: job.status,
    batchesCompleted: Number(job.batchesCompleted || 0),
    totalPostsResolved: Number(job.totalPostsResolved || 0),
    totalFailedPosts: Number(job.totalFailedPosts || 0),
    totalMediaQueued: Number(job.totalMediaQueued || 0),
    totalMediaSkipped: Number(job.totalMediaSkipped || 0),
    totalMediaFailed: Number(job.totalMediaFailed || 0),
    hasMore: Boolean(job.hasMore),
    pendingShortcodes: Array.isArray(job.pendingShortcodes) ? job.pendingShortcodes.length : 0,
    nextCursor: job.nextCursor || null,
    profileMediaFilter: job.profileMediaFilter || "all",
    duplicateMode: job.duplicateMode || "history",
    updatedAt: job.updatedAt || null,
    completedAt: job.completedAt || null,
    lastError: job.lastError || null,
    lastBatch: job.lastBatch || null,
    statusLine: `${job.totalMediaQueued || 0} queued, ${job.totalMediaSkipped || 0} skipped, ${job.totalMediaFailed || 0} failed across ${job.batchesCompleted || 0} batch${Number(job.batchesCompleted || 0) === 1 ? "" : "es"}. ${moreText}`
  };
}

function describeHttpFailure(status) {
  if (status === 401 || status === 403) {
    return "Instagram requires a logged-in session or denied access to this content.";
  }

  if (status === 404) {
    return "Instagram did not return this content. It may be unavailable or deleted.";
  }

  if (status === 429) {
    return "Instagram rate-limited the request. Wait a bit and try again.";
  }

  return `Instagram request failed with HTTP ${status}.`;
}

function formatProfileMediaFilterLabel(profileMediaFilter) {
  if (profileMediaFilter === "images") return "images only";
  if (profileMediaFilter === "videos") return "videos only";
  return "all media";
}

function describeProfilePaginationStopReason(stopReason) {
  const reasonMap = {
    requested_limit_reached: "Stopped because the requested profile-post limit was reached.",
    instagram_reported_end: "Stopped because Instagram reported there were no more profile pages.",
    missing_end_cursor: "Stopped because Instagram reported more pages but did not return a next cursor.",
    pagination_error: "Stopped because Instagram returned an error while fetching more profile pages.",
    iteration_cap: "Stopped after the extension's pagination safety cap was reached.",
    initial_page_sufficient: "Stopped because the initial profile page already satisfied the requested limit.",
    initial_page_only: "Stopped because Instagram returned only the initial profile page.",
    profile_id_missing: "Stopped because the profile id was missing for additional pagination.",
    no_profile_cursor: "Stopped because Instagram did not provide a pagination cursor for more profile pages."
  };

  return reasonMap[stopReason] || "Stopped after profile pagination completed.";
}

function shouldReportProfileProgress(current, total) {
  return total <= 8 || current === 1 || current === total || current % 5 === 0;
}

function applyProfileMediaFilter(items, profileMediaFilter) {
  if (profileMediaFilter === "images") {
    return items.filter((item) => item.type === "image");
  }

  if (profileMediaFilter === "videos") {
    return items.filter((item) => item.type === "video");
  }

  return items;
}

function buildProfileBatchDiagnostics(meta) {
  if (meta.pageKind !== "profile") {
    return [];
  }

  const diagnostics = [];
  const resolvedPosts = Number(meta.profilePostCount || 0);
  const failedPosts = Number(meta.failedPostCount || 0);
  diagnostics.push(`Resolved ${resolvedPosts} profile post${resolvedPosts === 1 ? "" : "s"}.`);
  diagnostics.push(describeProfilePaginationStopReason(meta.pagination?.stopReason));

  if (failedPosts > 0) {
    diagnostics.push(`${failedPosts} profile post${failedPosts === 1 ? "" : "s"} failed to resolve.`);
  }

  if (meta.profileMediaFilter && meta.profileMediaFilter !== "all") {
    diagnostics.push(`Applied profile filter: ${formatProfileMediaFilterLabel(meta.profileMediaFilter)}.`);
  }

  if (Number(meta.filteredItemCount || 0) !== Number(meta.unfilteredItemCount || 0)) {
    diagnostics.push(`Filter kept ${meta.filteredItemCount} of ${meta.unfilteredItemCount} media item${Number(meta.unfilteredItemCount || 0) === 1 ? "" : "s"}.`);
  }
  return diagnostics;
}

function buildPreviewCacheKey(tabUrl, settings) {
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

function getCachedPreview(cacheKey) {
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

function setCachedPreview(cacheKey, preview) {
  previewCache.set(cacheKey, {
    preview,
    expiresAt: Date.now() + PREVIEW_CACHE_TTL_MS
  });
}

function clearPreviewCacheForUrl(tabUrl) {
  if (!tabUrl) {
    previewCache.clear();
    return;
  }

  for (const key of previewCache.keys()) {
    if (key.includes(`"tabUrl":"${tabUrl.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)) {
      previewCache.delete(key);
    }
  }
}

function getEasyModeProbeSettings(settings) {
  return {
    ...settings,
    exportPostComments: false,
    maxProfilePosts: 1
  };
}

function getErrorPresentation(err) {
  const details = toErrorDetails(err);
  const code = details.code || "unknown";
  const defaults = {
    title: "Download failed",
    suggestion: "Try again, or reload the page if Instagram just changed state."
  };

  const presentationByCode = {
    unsupported_url: {
      title: "Unsupported page",
      suggestion: "Open an Instagram post, reel, story, highlight, or profile first."
    },
    invalid_shortcode: {
      title: "Missing post identifier",
      suggestion: "Reload the page and make sure the URL points to a single post or reel."
    },
    user_lookup_failed: {
      title: "Story user lookup failed",
      suggestion: "Make sure the story owner still exists and is visible in your current session."
    },
    story_unavailable: {
      title: "Story unavailable",
      suggestion: "The story may have expired, been hidden, or require an account with access."
    },
    story_not_found: {
      title: "Story item missing",
      suggestion: "The specific story frame may no longer be available."
    },
    post_unavailable: {
      title: "Post unavailable",
      suggestion: "Make sure the post is visible while logged in with this browser profile."
    },
    profile_unavailable: {
      title: "Profile unavailable",
      suggestion: "Make sure the profile exists and is visible in your current Instagram session."
    },
    profile_empty: {
      title: "No profile posts returned",
      suggestion: "Instagram returned the profile, but not any posts from the current page."
    },
    profile_posts_unavailable: {
      title: "Profile posts could not be resolved",
      suggestion: "The profile loaded, but the recent posts could not be converted into downloadable media."
    },
    profile_filter_empty: {
      title: "Profile filter matched nothing",
      suggestion: "Change the profile media filter in settings or open a different profile page."
    },
    no_media: {
      title: "No downloadable media found",
      suggestion: "Instagram returned metadata, but not a direct media URL for this page."
    },
    timeout: {
      title: "Instagram timed out",
      suggestion: "Wait a few seconds and try again."
    },
    download_failed: {
      title: "Browser download failed",
      suggestion: "Check your browser download settings or filesystem permissions."
    },
    content_script_unavailable: {
      title: "Page UI unavailable",
      suggestion: "Reload the Instagram tab and try again."
    },
    http_401: {
      title: "Login required",
      suggestion: "Open Instagram in this browser and confirm you are logged in."
    },
    http_403: {
      title: "Access denied",
      suggestion: "Instagram denied access to this content for the current session."
    },
    http_404: {
      title: "Content not found",
      suggestion: "The page may have been deleted or the URL may no longer be valid."
    },
    http_429: {
      title: "Rate limited",
      suggestion: "Wait a little before trying again. Instagram is throttling requests."
    }
  };

  const resolved = presentationByCode[code] || defaults;
  return {
    code,
    title: resolved.title,
    message: details.message || defaults.title,
    suggestion: resolved.suggestion,
    context: details.context || null,
    diagnostics: Array.isArray(details.context?.diagnostics) ? details.context.diagnostics : []
  };
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      credentials: options.credentials || "include"
    });

    const contentType = response.headers.get("content-type") || "";
    const body = contentType.includes("application/json")
      ? await response.json()
      : await response.text();

    if (!response.ok) {
      throw new InstagramResolverError(
        `http_${response.status}`,
        describeHttpFailure(response.status),
        {
          status: response.status,
          url,
          response: body
        }
      );
    }

    if (typeof body === "string") {
      throw new InstagramResolverError("invalid_response", "Instagram returned a non-JSON response.", {
        url,
        response: body
      });
    }

    return body;
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new InstagramResolverError("timeout", "Instagram request timed out.", { url, timeoutMs });
    }

    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseInstagramUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: "unsupported" };
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length >= 2 && ["p", "reel", "reels", "tv"].includes(parts[0])) {
    return {
      kind: "post",
      subtype: parts[0] === "p" ? "post" : parts[0],
      shortcode: parts[1]
    };
  }

  if (parts[0] === "stories" && parts[1] === "highlights" && parts[2]) {
    return {
      kind: "highlight",
      highlightId: parts[2]
    };
  }

  if (parts[0] === "stories" && parts[1]) {
    return {
      kind: "story",
      username: parts[1],
      storyPk: parts[2] || null
    };
  }

  if (parts.length === 1 && /^[A-Za-z0-9._]+$/.test(parts[0])) {
    const reserved = new Set(["accounts", "explore", "reels", "direct", "stories", "developer", "about", "legal"]);
    if (!reserved.has(parts[0])) {
      return {
        kind: "profile",
        username: parts[0]
      };
    }
  }

  return { kind: "unsupported" };
}

function getProfilePageFetchUrl(tabUrl, username) {
  try {
    const parsed = new URL(tabUrl || `https://www.instagram.com/${username || ""}/`);
    parsed.hash = "";
    parsed.search = "";
    if (username) {
      parsed.pathname = `/${username.replace(/^\/+|\/+$/g, "")}/`;
    }
    return parsed.href;
  } catch {
    return `https://www.instagram.com/${String(username || "").replace(/^\/+|\/+$/g, "")}/`;
  }
}

async function ensureInstagramSession(tabUrl, pk) {
  if (!pk) return;

  try {
    await fetchJsonWithTimeout(
      `https://i.instagram.com/api/v1/web/get_ruling_for_content/?content_type=MEDIA&target_id=${encodeURIComponent(pk)}`,
      {
        headers: getInstagramApiHeaders(tabUrl)
      },
      8000
    );
  } catch (err) {
    logWarn("session_bootstrap_failed", {
      tabUrl,
      pk,
      error: toErrorDetails(err)
    });
  }
}

async function fetchTextWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      credentials: options.credentials || "include"
    });

    const body = await response.text();
    if (!response.ok) {
      throw new InstagramResolverError(
        `http_${response.status}`,
        describeHttpFailure(response.status),
        {
          status: response.status,
          url,
          response: body
        }
      );
    }

    return body;
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new InstagramResolverError("timeout", "Instagram request timed out.", { url, timeoutMs });
    }

    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

function getCaptionText(media) {
  return (
    media?.caption?.text ||
    media?.edge_media_to_caption?.edges?.[0]?.node?.text ||
    media?.accessibility_caption ||
    null
  );
}

function extractOwner(media) {
  return {
    username: media?.user?.username || media?.owner?.username || "instagram",
    fullName: media?.user?.full_name || media?.owner?.full_name || "",
    ownerId: String(media?.user?.pk || media?.owner?.id || "") || null
  };
}

function getCarouselChildren(media) {
  if (Array.isArray(media?.carousel_media)) {
    return media.carousel_media;
  }

  if (Array.isArray(media?.edge_sidecar_to_children?.edges)) {
    return media.edge_sidecar_to_children.edges
      .map((edge) => edge?.node)
      .filter(Boolean);
  }

  return [];
}

function normalizePostEntry(media, meta, index) {
  const hasVideo = Boolean(media?.video_url || media?.video_versions?.length || media?.is_video);
  const bestVideoVersion = getLargestVideoVersion(media?.video_versions);
  const url = hasVideo
    ? normalizeUrl(media?.video_url || bestVideoVersion?.url)
    : normalizeUrl(media?.display_url || getLargestImageCandidateUrl(media?.image_versions2?.candidates));

  if (!url) {
    return null;
  }

  return {
    index,
    type: hasVideo ? "video" : "image",
    url,
    width: Number(bestVideoVersion?.width || media?.original_width || media?.dimensions?.width || 0) || null,
    height: Number(bestVideoVersion?.height || media?.original_height || media?.dimensions?.height || 0) || null,
    mediaId: String(media?.pk || media?.id || meta.id || index + 1),
    timestamp: Number(media?.taken_at || media?.taken_at_timestamp || meta.timestamp || 0) || null
  };
}

function buildPostPlan(media, descriptor, source) {
  const owner = extractOwner(media);
  const meta = {
    id: media?.code || descriptor.shortcode,
    postPk: String(media?.pk || media?.id || "") || null,
    username: owner.username,
    displayName: owner.fullName,
    ownerId: owner.ownerId,
    pageKind: descriptor.subtype,
    pageUrl: descriptor.shortcode ? `https://www.instagram.com/${descriptor.subtype === "post" ? "p" : descriptor.subtype}/${descriptor.shortcode}/` : null,
    caption: getCaptionText(media),
    timestamp: Number(media?.taken_at || media?.taken_at_timestamp || 0) || null,
    source,
    commentCount: Number(media?.comment_count || media?.edge_media_to_parent_comment?.count || 0) || null,
    likeCount: Number(media?.like_count || media?.edge_media_preview_like?.count || 0) || null,
    viewCount: Number(media?.view_count || media?.video_view_count || 0) || null
  };

  const children = getCarouselChildren(media);
  const sourceItems = children.length ? children : [media];
  const items = sourceItems
    .map((item, index) => normalizePostEntry(item, meta, index))
    .filter(Boolean);

  if (!items.length) {
    throw new InstagramResolverError(
      "no_media",
      "Instagram returned metadata for this page, but no downloadable media URLs were available.",
      { descriptor, source }
    );
  }

  return {
    meta,
    items: uniqBy(items, (item) => item.url)
  };
}

async function resolvePostPlan(tabUrl, descriptor) {
  const shortcode = descriptor.shortcode || extractShortcodeFromUrl(tabUrl);
  const pk = instagramShortcodeToPk(shortcode);
  if (!shortcode || !pk) {
    throw new InstagramResolverError("invalid_shortcode", "Could not determine the Instagram post identifier.", {
      tabUrl
    });
  }

  await ensureInstagramSession(tabUrl, pk);

  try {
    const infoData = await fetchJsonWithTimeout(
      `https://i.instagram.com/api/v1/media/${encodeURIComponent(pk)}/info/`,
      {
        headers: getInstagramApiHeaders(tabUrl)
      }
    );

    const media = Array.isArray(infoData?.items) ? infoData.items[0] : null;
    if (media) {
      return buildPostPlan(media, descriptor, "instagram_api_media_info");
    }
  } catch (err) {
    logWarn("post_info_failed", {
      tabUrl,
      shortcode,
      error: toErrorDetails(err)
    });
  }

  try {
    const variables = {
      shortcode,
      child_comment_count: 3,
      fetch_comment_count: 40,
      parent_comment_count: 24,
      has_threaded_comments: true
    };

    const graphqlUrl = new URL("https://www.instagram.com/graphql/query/");
    graphqlUrl.searchParams.set("doc_id", INSTAGRAM_GRAPHQL_DOC_ID);
    graphqlUrl.searchParams.set("variables", JSON.stringify(variables));

    const graphqlData = await fetchJsonWithTimeout(graphqlUrl.href, {
      headers: getInstagramApiHeaders(tabUrl)
    });

    const media = graphqlData?.data?.xdt_shortcode_media || null;
    if (media) {
      return buildPostPlan(media, descriptor, "instagram_api_graphql");
    }
  } catch (err) {
    logWarn("post_graphql_failed", {
      tabUrl,
      shortcode,
      error: toErrorDetails(err)
    });
  }

  throw new InstagramResolverError(
    "post_unavailable",
    "Could not resolve this Instagram post through the authenticated API. Check that the post is accessible in your current browser session.",
    { tabUrl, shortcode }
  );
}

async function lookupUserIdByUsername(username, tabUrl) {
  const url = new URL("https://i.instagram.com/api/v1/users/web_profile_info/");
  url.searchParams.set("username", username);
  const data = await fetchJsonWithTimeout(url.href, {
    headers: getInstagramApiHeaders(tabUrl)
  });

  const userId = data?.data?.user?.id || data?.data?.user?.pk;
  if (!userId) {
    throw new InstagramResolverError("user_lookup_failed", "Could not resolve the Instagram user for this story.", {
      username
    });
  }

  return String(userId);
}

async function fetchProfileInfo(username, tabUrl) {
  const url = new URL("https://i.instagram.com/api/v1/users/web_profile_info/");
  url.searchParams.set("username", username);
  const data = await fetchJsonWithTimeout(url.href, {
    headers: getInstagramApiHeaders(tabUrl)
  });

  const user = data?.data?.user || data?.user || null;
  if (!user) {
    throw new InstagramResolverError(
      "profile_unavailable",
      "Instagram did not return profile data for this user.",
      { username }
    );
  }

  return {
    user,
    raw: data
  };
}

function getDirectTimelineCandidates(profileInfo) {
  const user = profileInfo?.user || null;
  const raw = profileInfo?.raw || null;
  return [
    { path: "user.edge_owner_to_timeline_media", connection: user?.edge_owner_to_timeline_media },
    { path: "user.timeline_media", connection: user?.timeline_media },
    { path: "user.edge_felix_video_timeline", connection: user?.edge_felix_video_timeline },
    { path: "user.xdt_api__v1__feed__user_timeline_graphql_connection", connection: user?.xdt_api__v1__feed__user_timeline_graphql_connection },
    { path: "raw.data.user.edge_owner_to_timeline_media", connection: raw?.data?.user?.edge_owner_to_timeline_media },
    { path: "raw.data.user.timeline_media", connection: raw?.data?.user?.timeline_media },
    { path: "raw.data.user.edge_felix_video_timeline", connection: raw?.data?.user?.edge_felix_video_timeline },
    { path: "raw.data.user.xdt_api__v1__feed__user_timeline_graphql_connection", connection: raw?.data?.user?.xdt_api__v1__feed__user_timeline_graphql_connection },
    { path: "raw.user.edge_owner_to_timeline_media", connection: raw?.user?.edge_owner_to_timeline_media },
    { path: "raw.user.timeline_media", connection: raw?.user?.timeline_media },
    { path: "raw.user.edge_felix_video_timeline", connection: raw?.user?.edge_felix_video_timeline },
    { path: "raw.user.xdt_api__v1__feed__user_timeline_graphql_connection", connection: raw?.user?.xdt_api__v1__feed__user_timeline_graphql_connection }
  ].filter((entry) => Boolean(entry.connection));
}

function extractTimelineMatchFromConnection(connection, path = "timeline") {
  const shortcodes = (Array.isArray(connection?.edges) ? connection.edges : [])
    .map((edge) => edge?.node?.shortcode)
    .filter(Boolean);
  const nextCursor = connection?.page_info?.end_cursor || null;
  const hasNextPage = Boolean(connection?.page_info?.has_next_page);

  if (!shortcodes.length && !nextCursor) {
    return null;
  }

  return {
    shortcodes,
    nextCursor,
    hasNextPage,
    path
  };
}

function pickTimelineMatch(matches) {
  if (!matches.length) return null;

  const scoredMatches = matches.map((match) => {
    const path = String(match.path || "").toLowerCase();
    const pathScore = path.includes("edge_owner_to_timeline_media")
      ? 4
      : path.includes("timeline")
        ? 2
        : 0;

    return {
      ...match,
      score: match.shortcodes.length * 10 + pathScore + (match.hasNextPage ? 1 : 0)
    };
  });

  scoredMatches.sort((left, right) => right.score - left.score);
  return scoredMatches[0];
}

function findTimelineMatchInProfileInfo(profileInfo) {
  const user = profileInfo?.user || null;
  const username = String(user?.username || "").toLowerCase();
  const userId = String(user?.id || user?.pk || "");
  const directCandidates = getDirectTimelineCandidates(profileInfo);
  const directMatches = directCandidates
    .map(({ connection, path }) => extractTimelineMatchFromConnection(connection, path))
    .filter(Boolean);

  if (directMatches.length) {
    return pickTimelineMatch(directMatches);
  }

  const root = profileInfo?.raw || user;
  if (!root || typeof root !== "object") {
    return null;
  }

  const matches = [];
  const visited = new Set();

  function visit(value, path, depth) {
    if (!value || typeof value !== "object" || depth > 6 || visited.has(value)) {
      return;
    }

    visited.add(value);

    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        visit(value[index], `${path}[${index}]`, depth + 1);
      }
      return;
    }

    const connectionMatch = extractTimelineMatchFromConnection(value, path);
    if (connectionMatch) {
      const edges = Array.isArray(value.edges) ? value.edges : [];
      const belongsToUser = edges.some((edge) => {
        const owner = edge?.node?.owner;
        const ownerUsername = String(owner?.username || "").toLowerCase();
        const ownerId = String(owner?.id || owner?.pk || "");
        return (username && ownerUsername === username) || (userId && ownerId === userId);
      });
      const pathText = String(path || "").toLowerCase();
      if (belongsToUser || pathText.includes("timeline") || pathText.includes("edge_owner")) {
        matches.push(connectionMatch);
      }
    }

    for (const [key, nestedValue] of Object.entries(value)) {
      visit(nestedValue, path ? `${path}.${key}` : key, depth + 1);
    }
  }

  visit(root, "root", 0);
  return pickTimelineMatch(matches);
}

function extractShortcodeFromProfileFeedItem(item) {
  const queue = [item];
  const visited = new Set();

  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || visited.has(current)) {
      continue;
    }

    visited.add(current);

    if (typeof current.code === "string" && current.code) {
      return current.code;
    }

    if (typeof current.shortcode === "string" && current.shortcode) {
      return current.shortcode;
    }

    queue.push(current.media_or_ad, current.media, current.node);
  }

  return null;
}

function extractShortcodesFromProfileFeedResponse(data) {
  const entries = [
    ...(Array.isArray(data?.items) ? data.items : []),
    ...(Array.isArray(data?.profile_grid_items) ? data.profile_grid_items : [])
  ];

  return uniqBy(
    entries.map((entry) => extractShortcodeFromProfileFeedItem(entry)).filter(Boolean),
    (shortcode) => shortcode
  );
}

function extractShortcodesFromHtml(html) {
  if (!html) return [];

  const patterns = [
    /"shortcode":"([A-Za-z0-9_-]{5,})"/g,
    /\/(?:p|reel|reels)\/([A-Za-z0-9_-]{5,})/g
  ];

  const shortcodes = [];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      shortcodes.push(match[1]);
    }
  }

  return Array.from(new Set(shortcodes));
}

async function fetchProfilePageShortcodes(tabUrl, username, requestedCount) {
  const pageUrl = getProfilePageFetchUrl(tabUrl, username);
  const html = await fetchTextWithTimeout(pageUrl, {
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      Referer: pageUrl
    }
  }, 12000);

  const shortcodes = extractShortcodesFromHtml(html).slice(0, Math.max(1, requestedCount || 12));
  return {
    shortcodes,
    nextCursor: null,
    hasNextPage: false,
    source: "profile_html"
  };
}

async function fetchProfileTimelinePage(userId, afterCursor, tabUrl, pageSize = 12) {
  const feedUrl = new URL(`https://i.instagram.com/api/v1/feed/user/${encodeURIComponent(userId)}/`);
  feedUrl.searchParams.set("count", String(pageSize));
  if (afterCursor) {
    feedUrl.searchParams.set("max_id", afterCursor);
  }

  const data = await fetchJsonWithTimeout(feedUrl.href, {
    headers: getInstagramApiHeaders(tabUrl)
  });

  const shortcodes = extractShortcodesFromProfileFeedResponse(data);
  const nextCursor = data?.next_max_id || data?.profile_grid_items_cursor || null;
  const hasNextPage = Boolean(data?.more_available || nextCursor);
  return {
    shortcodes,
    nextCursor,
    hasNextPage
  };
}

async function getInitialProfileTimeline(profileInfo, tabUrl, requestedCount) {
  const normalizedProfileInfo = profileInfo?.user
    ? profileInfo
    : { user: profileInfo, raw: profileInfo };
  const user = normalizedProfileInfo.user;
  const extractedTimeline = findTimelineMatchInProfileInfo(normalizedProfileInfo);

  if (extractedTimeline) {
    return {
      shortcodes: extractedTimeline.shortcodes,
      nextCursor: extractedTimeline.nextCursor,
      hasNextPage: extractedTimeline.hasNextPage,
      source: "web_profile_info"
    };
  }

  const userId = String(user?.id || user?.pk || "") || null;
  if (!userId) {
    try {
      const htmlFallbackTimeline = await fetchProfilePageShortcodes(tabUrl, user?.username, requestedCount);
      if (htmlFallbackTimeline.shortcodes.length > 0) {
        return htmlFallbackTimeline;
      }
    } catch (htmlErr) {
      logWarn("profile_initial_html_fallback_failed", {
        username: user?.username || null,
        error: toErrorDetails(htmlErr)
      });
    }
    return {
      shortcodes: [],
      nextCursor: null,
      hasNextPage: false,
      source: "web_profile_info"
    };
  }

  try {
    const fallbackTimeline = await fetchProfileTimelinePage(
      userId,
      null,
      tabUrl,
      Math.min(12, Math.max(1, requestedCount || 12))
    );
    return {
      ...fallbackTimeline,
      source: "profile_feed_first_page"
    };
  } catch (err) {
    logWarn("profile_initial_timeline_fallback_failed", {
      userId,
      error: toErrorDetails(err)
    });
    try {
      const htmlFallbackTimeline = await fetchProfilePageShortcodes(tabUrl, user?.username, requestedCount);
      if (htmlFallbackTimeline.shortcodes.length > 0) {
        return htmlFallbackTimeline;
      }
    } catch (htmlErr) {
      logWarn("profile_initial_html_fallback_failed", {
        username: user?.username || null,
        error: toErrorDetails(htmlErr)
      });
    }
    return {
      shortcodes: [],
      nextCursor: null,
      hasNextPage: false,
      source: "web_profile_info"
    };
  }
}

async function createFullProfileCrawlJob(user, tabUrl, settings) {
  const initialTimeline = await getInitialProfileTimeline(user, tabUrl, FULL_PROFILE_CRAWL_POST_BATCH_LIMIT);
  const profileUser = user?.user || user;
  const pendingShortcodes = initialTimeline.shortcodes;

  return {
    username: profileUser?.username || "instagram",
    userId: String(profileUser?.id || profileUser?.pk || "") || null,
    pageUrl: tabUrl,
    title: profileUser?.full_name ? `${profileUser.full_name} (@${profileUser.username})` : `@${profileUser?.username || "instagram"}`,
    status: "paused",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    hasMore: Boolean(initialTimeline.hasNextPage && initialTimeline.nextCursor),
    nextCursor: initialTimeline.nextCursor || null,
    pendingShortcodes,
    profileMediaFilter: settings.profileMediaFilter,
    duplicateMode: settings.duplicateMode,
    batchesCompleted: 0,
    totalPostsResolved: 0,
    totalFailedPosts: 0,
    totalMediaQueued: 0,
    totalMediaSkipped: 0,
    totalMediaFailed: 0,
    lastError: null,
    lastBatch: null
  };
}

async function collectFullProfileCrawlBatch(job, tabUrl) {
  const selectedShortcodes = [];
  const pendingShortcodes = Array.isArray(job.pendingShortcodes) ? [...job.pendingShortcodes] : [];
  let nextCursor = job.nextCursor || null;
  let hasMore = Boolean(job.hasMore);
  let pagesFetched = 0;

  while (selectedShortcodes.length < FULL_PROFILE_CRAWL_POST_BATCH_LIMIT && pendingShortcodes.length > 0) {
    selectedShortcodes.push(pendingShortcodes.shift());
  }

  while (
    selectedShortcodes.length < FULL_PROFILE_CRAWL_POST_BATCH_LIMIT &&
    hasMore &&
    nextCursor &&
    pagesFetched < FULL_PROFILE_CRAWL_PAGE_FETCH_LIMIT
  ) {
    const page = await fetchProfileTimelinePage(job.userId, nextCursor, tabUrl);
    pagesFetched += 1;
    pendingShortcodes.push(...page.shortcodes);
    nextCursor = page.nextCursor;
    hasMore = page.hasNextPage;

    while (selectedShortcodes.length < FULL_PROFILE_CRAWL_POST_BATCH_LIMIT && pendingShortcodes.length > 0) {
      selectedShortcodes.push(pendingShortcodes.shift());
    }
  }

  return {
    shortcodes: Array.from(new Set(selectedShortcodes)),
    pendingShortcodes,
    nextCursor,
    hasMore: pendingShortcodes.length > 0 || Boolean(hasMore && nextCursor),
    pagesFetched,
    stopReason: pendingShortcodes.length > 0 || (hasMore && nextCursor)
      ? "batch_limit_reached"
      : "crawl_completed"
  };
}

async function fetchAdditionalProfileShortcodes(userId, afterCursor, tabUrl, remainingLimit) {
  const shortcodes = [];
  let cursor = afterCursor || null;
  let iterations = 0;
  const diagnostics = {
    pagesFetched: 0,
    stopReason: remainingLimit <= 0 ? "requested_limit_reached" : cursor ? null : "no_profile_cursor",
    error: null
  };

  while (cursor && shortcodes.length < remainingLimit && iterations < 8) {
    iterations += 1;
    diagnostics.pagesFetched = iterations;
    try {
      const page = await fetchProfileTimelinePage(
        userId,
        cursor,
        tabUrl,
        Math.min(12, remainingLimit - shortcodes.length)
      );

      shortcodes.push(...page.shortcodes);

      if (shortcodes.length >= remainingLimit) {
        diagnostics.stopReason = "requested_limit_reached";
        break;
      }

      if (!page.hasNextPage) {
        diagnostics.stopReason = "instagram_reported_end";
        break;
      }

      cursor = page.nextCursor || null;
      if (!cursor) {
        diagnostics.stopReason = "missing_end_cursor";
        break;
      }
    } catch (err) {
      logWarn("profile_pagination_failed", {
        userId,
        error: toErrorDetails(err)
      });
      diagnostics.stopReason = "pagination_error";
      diagnostics.error = toErrorDetails(err);
      break;
    }
  }

  if (!diagnostics.stopReason) {
    diagnostics.stopReason = cursor && iterations >= 8 ? "iteration_cap" : "instagram_reported_end";
  }

  return {
    shortcodes,
    diagnostics
  };
}

async function resolveProfilePlan(tabUrl, descriptor, settings, progressCallback = null) {
  const profileInfo = await fetchProfileInfo(descriptor.username, tabUrl);
  const user = profileInfo.user;
  const initialTimeline = await getInitialProfileTimeline(profileInfo, tabUrl, settings.maxProfilePosts);
  const initialShortcodes = initialTimeline.shortcodes;
  let shortcodes = [...initialShortcodes];
  let pagination = {
    initialCount: initialShortcodes.length,
    additionalCount: 0,
    pagesFetched: 0,
    stopReason: initialShortcodes.length >= settings.maxProfilePosts
      ? "initial_page_sufficient"
      : initialTimeline.hasNextPage
        ? (user?.id || user?.pk)
          ? null
          : "profile_id_missing"
        : "initial_page_only",
    error: null,
    source: initialTimeline.source
  };

  const remaining = Math.max(0, settings.maxProfilePosts - shortcodes.length);
  if (remaining > 0 && initialTimeline.hasNextPage && initialTimeline.nextCursor && (user?.id || user?.pk)) {
    const additional = await fetchAdditionalProfileShortcodes(
      String(user.id || user.pk),
      initialTimeline.nextCursor,
      tabUrl,
      remaining
    );
    shortcodes.push(...additional.shortcodes);
    pagination = {
      ...pagination,
      additionalCount: additional.shortcodes.length,
      pagesFetched: additional.diagnostics.pagesFetched,
      stopReason: additional.diagnostics.stopReason,
      error: additional.diagnostics.error
    };
  } else if (remaining > 0 && initialTimeline.hasNextPage && !initialTimeline.nextCursor) {
    pagination = {
      ...pagination,
      stopReason: "no_profile_cursor"
    };
  }

  shortcodes = Array.from(new Set(shortcodes)).slice(0, settings.maxProfilePosts);
  if (!shortcodes.length) {
    throw new InstagramResolverError(
      "profile_empty",
      "Instagram did not return any posts for this profile page.",
      { username: descriptor.username }
    );
  }

  const aggregatedItems = [];
  const failedPosts = [];

  for (let index = 0; index < shortcodes.length; index += 1) {
    const shortcode = shortcodes[index];
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
      failedPosts.push({
        shortcode,
        error: toErrorDetails(err)
      });
      logWarn("profile_post_resolution_failed", {
        shortcode,
        error: toErrorDetails(err)
      });
    }
  }

  const unfilteredItems = uniqBy(aggregatedItems, (item) => item.url);
  if (!unfilteredItems.length) {
    throw new InstagramResolverError(
      "profile_posts_unavailable",
      "The profile was found, but none of its posts could be resolved into downloadable media.",
      {
        username: descriptor.username,
        failedPosts
      }
    );
  }

  const filteredItems = applyProfileMediaFilter(unfilteredItems, settings.profileMediaFilter);
  if (!filteredItems.length) {
    throw new InstagramResolverError(
      "profile_filter_empty",
      `The profile returned media, but none matched the selected profile filter: ${formatProfileMediaFilterLabel(settings.profileMediaFilter)}.`,
      {
        username: descriptor.username,
        profileMediaFilter: settings.profileMediaFilter
      }
    );
  }

  return {
    meta: {
      id: descriptor.username,
      username: user?.username || descriptor.username,
      displayName: user?.full_name || "",
      ownerId: String(user?.id || user?.pk || "") || null,
      pageKind: "profile",
      title: user?.full_name ? `${user.full_name} (@${user.username})` : `@${descriptor.username}`,
      caption: user?.biography || null,
      pageUrl: tabUrl,
      timestamp: null,
      source: "instagram_profile_batch",
      profilePostCount: shortcodes.length,
      failedPostCount: failedPosts.length,
      profileMediaFilter: settings.profileMediaFilter,
      unfilteredItemCount: unfilteredItems.length,
      filteredItemCount: filteredItems.length,
      pagination
    },
    items: filteredItems
  };
}

async function resolveProfileBatchPlanFromShortcodes(tabUrl, job, shortcodes, settings, progressCallback = null) {
  const aggregatedItems = [];
  const failedPosts = [];

  for (let index = 0; index < shortcodes.length; index += 1) {
    const shortcode = shortcodes[index];
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
      failedPosts.push({
        shortcode,
        error: toErrorDetails(err)
      });
      logWarn("crawl_post_resolution_failed", {
        shortcode,
        error: toErrorDetails(err)
      });
    }
  }

  const unfilteredItems = uniqBy(aggregatedItems, (item) => item.url);
  const filteredItems = applyProfileMediaFilter(unfilteredItems, settings.profileMediaFilter);

  return {
    meta: {
      id: job.username,
      username: job.username,
      displayName: job.title || `@${job.username}`,
      ownerId: job.userId || null,
      pageKind: "profile",
      title: job.title || `@${job.username}`,
      caption: null,
      pageUrl: job.pageUrl || tabUrl,
      timestamp: null,
      source: "instagram_profile_full_crawl",
      profilePostCount: shortcodes.length,
      failedPostCount: failedPosts.length,
      profileMediaFilter: settings.profileMediaFilter,
      unfilteredItemCount: unfilteredItems.length,
      filteredItemCount: filteredItems.length,
      pagination: null
    },
    items: filteredItems,
    failedPosts
  };
}

function normalizeStoryEntry(item, meta, index) {
  const bestVideoVersion = getLargestVideoVersion(item?.video_versions);
  const hasVideo = Boolean(bestVideoVersion?.url || item?.video_url || item?.media_type === 2);
  const url = hasVideo
    ? normalizeUrl(item?.video_url || bestVideoVersion?.url)
    : normalizeUrl(getLargestImageCandidateUrl(item?.image_versions2?.candidates) || item?.display_url);

  if (!url) {
    return null;
  }

  return {
    index,
    type: hasVideo ? "video" : "image",
    url,
    width: Number(bestVideoVersion?.width || item?.original_width || 0) || null,
    height: Number(bestVideoVersion?.height || item?.original_height || 0) || null,
    mediaId: String(item?.pk || item?.id || meta.id || index + 1),
    timestamp: Number(item?.taken_at || 0) || null,
    expiresAt: Number(item?.expiring_at || 0) || null
  };
}

function buildStoryPlan(reel, descriptor, source) {
  const reelItems = Array.isArray(reel?.items) ? reel.items : [];
  const owner = extractOwner(reel?.user ? { user: reel.user } : reel);
  const filteredItems = descriptor.storyPk
    ? reelItems.filter((item) => String(item?.pk || item?.id || "") === String(descriptor.storyPk))
    : reelItems;

  if (!filteredItems.length) {
    throw new InstagramResolverError(
      "story_not_found",
      "The requested story item was not returned by Instagram.",
      { descriptor }
    );
  }

  const meta = {
    id: descriptor.highlightId || descriptor.storyPk || owner.ownerId || descriptor.username,
    username: owner.username || descriptor.username || "instagram",
    displayName: reel?.user?.full_name || "",
    ownerId: owner.ownerId,
    pageKind: descriptor.kind,
    pageUrl: null,
    title: reel?.title || null,
    caption: null,
    timestamp: Number(filteredItems[0]?.taken_at || 0) || null,
    source
  };

  const items = filteredItems
    .map((item, index) => normalizeStoryEntry(item, meta, index))
    .filter(Boolean);

  if (!items.length) {
    throw new InstagramResolverError(
      "no_media",
      "Instagram returned story metadata, but no downloadable media URLs were available.",
      { descriptor, source }
    );
  }

  return {
    meta,
    items: uniqBy(items, (item) => item.url)
  };
}

async function resolveStoryPlan(tabUrl, descriptor) {
  const reelId = descriptor.kind === "highlight"
    ? `highlight:${descriptor.highlightId}`
    : await lookupUserIdByUsername(descriptor.username, tabUrl);

  const reelsUrl = new URL("https://i.instagram.com/api/v1/feed/reels_media/");
  reelsUrl.searchParams.set("reel_ids", reelId);
  const data = await fetchJsonWithTimeout(reelsUrl.href, {
    headers: getInstagramApiHeaders(tabUrl)
  });

  const reel = data?.reels?.[reelId];
  if (!reel) {
    throw new InstagramResolverError(
      "story_unavailable",
      "Instagram did not return story data for this page. Check that the story or highlight is still available and visible in your account.",
      { tabUrl, descriptor }
    );
  }

  const plan = buildStoryPlan(reel, descriptor, "instagram_api_reels_media");
  return {
    ...plan,
    meta: {
      ...plan.meta,
      pageUrl: tabUrl
    }
  };
}

async function resolveDownloadPlan(tabUrl, settings = null, progressCallback = null) {
  const descriptor = parseInstagramUrl(tabUrl);
  const resolvedSettings = settings || await getSettings();

  if (descriptor.kind === "post") {
    return resolvePostPlan(tabUrl, descriptor);
  }

  if (descriptor.kind === "story" || descriptor.kind === "highlight") {
    return resolveStoryPlan(tabUrl, descriptor);
  }

  if (descriptor.kind === "profile") {
    return resolveProfilePlan(tabUrl, descriptor, resolvedSettings, progressCallback);
  }

  throw new InstagramResolverError(
    "unsupported_url",
    "Open an Instagram post, reel, story, highlight, or profile first.",
    { tabUrl }
  );
}

function buildTemplateContext(meta, item, itemIndex) {
  const timestamp = item?.timestamp || meta?.timestamp;
  const date = timestamp ? new Date(timestamp * 1000).toISOString().slice(0, 10) : "unknown-date";

  return {
    username: meta?.username || "instagram",
    id: item?.postId || meta?.id || item?.mediaId || "media",
    index: String(itemIndex + 1).padStart(2, "0"),
    kind: meta?.pageKind || "media",
    type: item?.type || "media",
    date
  };
}

function trimSlashes(value) {
  return String(value || "").replace(/^\/+|\/+$/g, "");
}

function splitRelativePath(relativePath) {
  const cleanPath = trimSlashes(relativePath);
  const lastSlashIndex = cleanPath.lastIndexOf("/");
  const directory = lastSlashIndex >= 0 ? cleanPath.slice(0, lastSlashIndex) : "";
  const fileName = lastSlashIndex >= 0 ? cleanPath.slice(lastSlashIndex + 1) : cleanPath;
  const extensionIndex = fileName.lastIndexOf(".");

  return {
    directory,
    baseName: extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName,
    extension: extensionIndex > 0 ? fileName.slice(extensionIndex) : ""
  };
}

function joinRelativePath(directory, fileName) {
  return directory ? `${trimSlashes(directory)}/${fileName}` : fileName;
}

function ensureUniqueRelativePath(relativePath, uniqueHint, usedPaths) {
  const pathInfo = splitRelativePath(relativePath);
  const cleanHint = sanitizeFilenamePart(uniqueHint || "").replace(/\s+/g, "_") || "unique";
  let candidate = joinRelativePath(pathInfo.directory, `${pathInfo.baseName}${pathInfo.extension}`);

  if (!usedPaths.has(candidate)) {
    usedPaths.add(candidate);
    return candidate;
  }

  candidate = joinRelativePath(pathInfo.directory, `${pathInfo.baseName}__${cleanHint}${pathInfo.extension}`);
  if (!usedPaths.has(candidate)) {
    usedPaths.add(candidate);
    return candidate;
  }

  let counter = 2;
  while (usedPaths.has(candidate)) {
    candidate = joinRelativePath(pathInfo.directory, `${pathInfo.baseName}__${cleanHint}_${counter}${pathInfo.extension}`);
    counter += 1;
  }

  usedPaths.add(candidate);
  return candidate;
}

function buildMediaFilename(item, meta, itemIndex, settings) {
  const context = buildTemplateContext(meta, item, itemIndex);
  const baseFolder = trimSlashes(applyTemplate(settings.folderTemplate, context, "instagram"));
  const baseName = applyTemplate(settings.filenameTemplate, context, `${context.username}_${context.id}_${context.index}`);
  const extension = guessExtension(item.url, item.type);
  const fileName = `${sanitizeFilenamePart(baseName)}.${extension}`;

  return baseFolder ? `${baseFolder}/${fileName}` : fileName;
}

function buildMetadataFilename(meta, settings) {
  const context = buildTemplateContext(meta, null, 0);
  const baseFolder = trimSlashes(applyTemplate(settings.folderTemplate, context, "instagram"));
  const baseName = applyTemplate(
    settings.metadataFilenameTemplate,
    context,
    `${context.username}_${context.id}_metadata`
  );
  const fileName = `${sanitizeFilenamePart(baseName)}.json`;

  if (settings.placeMetadataInSubfolder) {
    const metadataFolder = baseFolder ? `${baseFolder}/_metadata` : "_metadata";
    return `${metadataFolder}/${fileName}`;
  }

  return baseFolder ? `${baseFolder}/${fileName}` : fileName;
}

function buildBatchReportFilename(meta, settings) {
  const context = buildTemplateContext(meta, null, 0);
  const baseFolder = trimSlashes(applyTemplate(settings.folderTemplate, context, "instagram"));
  const fileName = `${sanitizeFilenamePart(`${context.username}_${context.id}_report`)}.json`;
  const reportFolder = baseFolder ? `${baseFolder}/_reports` : "_reports";
  return `${reportFolder}/${fileName}`;
}

function buildPlannedEntries(plan, settings, knownDownloadKeys = new Set()) {
  const usedPaths = new Set();

  return plan.items.map((item, itemIndex) => {
    const desiredFilename = buildMediaFilename(item, plan.meta, itemIndex, settings);
    const uniqueHint = item.mediaId || item.postId || `${item.type}_${itemIndex + 1}`;
    const filename = ensureUniqueRelativePath(desiredFilename, uniqueHint, usedPaths);

    return {
      item,
      index: itemIndex,
      filename,
      downloadKey: buildDownloadKey(item),
      alreadyDownloaded: knownDownloadKeys.has(buildDownloadKey(item))
    };
  });
}

function createMetadataDocument(plan, queuedDownloads) {
  return {
    generatedAt: new Date().toISOString(),
    source: plan.meta.source,
    pageKind: plan.meta.pageKind,
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

function createBatchReportDocument(plan, result, settings) {
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

async function fetchPostComments(postPk, tabUrl) {
  if (!postPk) {
    return [];
  }

  const commentsUrl = new URL(`https://i.instagram.com/api/v1/media/${encodeURIComponent(postPk)}/comments/`);
  commentsUrl.searchParams.set("can_support_threading", "true");
  commentsUrl.searchParams.set("permalink_enabled", "false");

  const data = await fetchJsonWithTimeout(commentsUrl.href, {
    headers: getInstagramApiHeaders(tabUrl)
  });

  const commentItems = Array.isArray(data?.comments)
    ? data.comments
    : Array.isArray(data?.edge_media_to_parent_comment?.edges)
      ? data.edge_media_to_parent_comment.edges.map((edge) => edge?.node).filter(Boolean)
      : [];

  return commentItems.map((comment) => ({
    id: String(comment?.pk || comment?.id || "") || null,
    text: comment?.text || null,
    author: comment?.user?.username || comment?.owner?.username || null,
    authorId: String(comment?.user?.pk || comment?.owner?.id || "") || null,
    timestamp: Number(comment?.created_at || 0) || null,
    likeCount: Number(comment?.comment_like_count || comment?.edge_liked_by?.count || 0) || null
  }));
}

async function enrichPlanMetadata(plan, tabUrl, settings) {
  if (!settings.exportPostComments) {
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

async function queueBatchReportDownload(plan, result, reportFilename, settings) {
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

async function queueDownloads(plan, settings) {
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

async function clearBadge(tabId, title = DEFAULT_ACTION_TITLE) {
  if (!tabId) return;

  try {
    await chrome.action.setBadgeText({ tabId, text: "" });
    await chrome.action.setTitle({ tabId, title });
  } catch (err) {
    logWarn("badge_clear_failed", {
      tabId,
      error: toErrorDetails(err)
    });
  }
}

async function setBadge(tabId, text, color, title) {
  if (!tabId) return;

  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
    await chrome.action.setBadgeText({ tabId, text });
    if (title) {
      await chrome.action.setTitle({ tabId, title });
    }
  } catch (err) {
    logWarn("badge_set_failed", {
      tabId,
      text,
      error: toErrorDetails(err)
    });
  }
}

async function syncActionAvailability(tab, settings = null) {
  const tabId = tab?.id;
  if (!tabId) {
    return false;
  }

  const tabUrl = tab?.url || "";
  const isSupportedTab = isInstagramUrl(tabUrl);

  try {
    if (!isSupportedTab) {
      await chrome.action.disable(tabId);
      await clearBadge(tabId, "Open an Instagram page to use this extension");
      return false;
    }

    await chrome.action.enable(tabId);
    if (!(settings || await getSettings()).easyMode) {
      await clearBadge(tabId);
    }
    return true;
  } catch (err) {
    logWarn("action_availability_sync_failed", {
      tabId,
      error: toErrorDetails(err)
    });
    return isSupportedTab;
  }
}

async function syncActionPresentation(settings = null) {
  const resolvedSettings = settings || await getSettings();
  await chrome.action.setPopup({
    popup: resolvedSettings.easyMode ? "" : DEFAULT_POPUP_PATH
  });

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.id) {
    await syncActionAvailability(activeTab, resolvedSettings);
    scheduleAvailabilityBadgeRefresh(activeTab);
  }
}

async function updateAvailabilityBadge(tab) {
  const settings = await getSettings();
  const tabId = tab?.id;
  const tabUrl = tab?.url || "";

  if (!tabId) {
    return;
  }

  const actionEnabled = await syncActionAvailability(tab, settings);
  if (!actionEnabled) {
    return;
  }

  if (!settings.easyMode) {
    await clearBadge(tabId);
    return;
  }

  if (!isInstagramUrl(tabUrl)) {
    await clearBadge(tabId);
    return;
  }

  try {
    await resolveDownloadPlan(tabUrl, getEasyModeProbeSettings(settings));
    await setBadge(
      tabId,
      "OK",
      BADGE_COLORS.success,
      "This Instagram page is ready to download"
    );
  } catch (err) {
    const presentation = getErrorPresentation(err);
    await setBadge(tabId, "NO", BADGE_COLORS.error, presentation.title);
  }
}

function scheduleAvailabilityBadgeRefresh(tab) {
  const tabId = tab?.id;
  if (!tabId) {
    return;
  }

  clearTimeout(badgeRefreshTimers.get(tabId));
  const timeoutId = setTimeout(async () => {
    badgeRefreshTimers.delete(tabId);
    try {
      await updateAvailabilityBadge(tab);
    } catch (err) {
      logWarn("availability_badge_refresh_failed", {
        tabId,
        error: toErrorDetails(err)
      });
    }
  }, BADGE_REFRESH_DELAY_MS);

  badgeRefreshTimers.set(tabId, timeoutId);
}

function clearBadgeSoon(tabId, tabUrl, delayMs = 3500) {
  if (!tabId) return;

  setTimeout(async () => {
    const settings = await getSettings();
    if (settings.easyMode) {
      scheduleAvailabilityBadgeRefresh({ id: tabId, url: tabUrl || "" });
      return;
    }

    await clearBadge(tabId);
  }, delayMs);
}

function isMissingReceiverError(err) {
  const message = String(err?.message || err || "").toLowerCase();
  return message.includes("receiving end does not exist") || message.includes("could not establish connection");
}

async function pingContentScript(tabId) {
  const response = await chrome.tabs.sendMessage(tabId, { type: "PING" });
  return response?.ok === true;
}

async function ensureContentScript(tabId) {
  try {
    const ready = await pingContentScript(tabId);
    if (ready) return;
  } catch (err) {
    if (!isMissingReceiverError(err)) {
      throw err;
    }
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });

  const readyAfterInjection = await pingContentScript(tabId);
  if (!readyAfterInjection) {
    throw new InstagramResolverError(
      "content_script_unavailable",
      "The extension UI could not be attached to this Instagram tab.",
      { tabId }
    );
  }
}

async function sendToast(tabId, message, level = "info") {
  if (!tabId) return;

  try {
    await ensureContentScript(tabId);
    await chrome.tabs.sendMessage(tabId, {
      type: "SHOW_STATUS_TOAST",
      message,
      level
    });
  } catch (err) {
    logWarn("toast_send_failed", {
      tabId,
      message,
      error: toErrorDetails(err)
    });
  }
}

function buildSummary(plan) {
  const imageCount = plan.items.filter((item) => item.type === "image").length;
  const videoCount = plan.items.filter((item) => item.type === "video").length;

  return {
    username: plan.meta.username,
    id: plan.meta.id,
    pageKind: plan.meta.pageKind,
    imageCount,
    videoCount,
    totalCount: plan.items.length
  };
}

function buildPlanPreview(plan, settings, knownDownloadKeys = new Set()) {
  const summary = buildSummary(plan);
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

async function getPagePreview(tab) {
  const tabUrl = tab?.url || "";
  if (!tab?.id || !isInstagramUrl(tabUrl)) {
    throw new InstagramResolverError(
      "unsupported_url",
      "Open an Instagram post, reel, story, highlight, or profile first.",
      { tabUrl }
    );
  }

  const settings = await getSettings();
  const cacheKey = buildPreviewCacheKey(tabUrl, settings);
  const cachedPreview = getCachedPreview(cacheKey);
  if (cachedPreview) {
    return {
      ...cachedPreview,
      crawlJob: cachedPreview.summary.pageKind === "profile"
        ? summarizeCrawlJob(await getCrawlJob(cachedPreview.meta.username || cachedPreview.summary.username))
        : null
    };
  }

  const resolvedPlan = await resolveDownloadPlan(tabUrl, settings);
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
  if (plan.meta.pageKind === "profile") {
    preview.crawlJob = summarizeCrawlJob(await getCrawlJob(plan.meta.username));
  }
  setCachedPreview(cacheKey, preview);
  return preview;
}

async function getDownloadHistory() {
  const state = await getDownloadState();
  return {
    ok: true,
    history: state.downloadHistory
  };
}

async function exportDownloadHistory() {
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

async function clearDownloadHistory() {
  const state = await getDownloadState();
  await saveDownloadState([], [], state.crawlJobs);
  return { ok: true };
}

async function getProfileCrawlStatus(tab) {
  const tabUrl = tab?.url || "";
  const descriptor = parseInstagramUrl(tabUrl);
  if (descriptor.kind !== "profile") {
    return {
      ok: true,
      crawlJob: null
    };
  }

  const crawlJob = await getCrawlJob(descriptor.username);
  return {
    ok: true,
    crawlJob: summarizeCrawlJob(crawlJob)
  };
}

async function resetFullProfileCrawl(tab) {
  const tabUrl = tab?.url || "";
  const descriptor = parseInstagramUrl(tabUrl);
  if (descriptor.kind !== "profile") {
    throw new InstagramResolverError(
      "unsupported_url",
      "Open an Instagram profile page before resetting a full crawl job.",
      { tabUrl }
    );
  }

  await removeCrawlJob(descriptor.username);
  return {
    ok: true
  };
}

async function runFullProfileCrawl(tab) {
  if (!tab?.id) {
    return { ok: false };
  }

  const tabId = tab.id;
  const tabUrl = tab.url || "";
  const descriptor = parseInstagramUrl(tabUrl);
  if (descriptor.kind !== "profile") {
    throw new InstagramResolverError(
      "unsupported_url",
      "Open an Instagram profile page before starting a full crawl.",
      { tabUrl }
    );
  }

  const settings = await getSettings();
  let crawlJob = await getCrawlJob(descriptor.username);

  if (!crawlJob || crawlJob.status === "completed") {
    const profileInfo = await fetchProfileInfo(descriptor.username, tabUrl);
    crawlJob = await createFullProfileCrawlJob(profileInfo, tabUrl, settings);
  }

  crawlJob = {
    ...crawlJob,
    pageUrl: tabUrl,
    profileMediaFilter: settings.profileMediaFilter,
    duplicateMode: settings.duplicateMode,
    status: "running",
    updatedAt: new Date().toISOString(),
    lastError: null
  };
  await saveCrawlJob(crawlJob);

  await setBadge(tabId, "CR", BADGE_COLORS.working, `Crawling @${crawlJob.username}`);
  await sendToast(tabId, `Continuing full crawl for @${crawlJob.username}...`, "info");

  try {
    const batch = await collectFullProfileCrawlBatch(crawlJob, tabUrl);
    if (!batch.shortcodes.length) {
      crawlJob = {
        ...crawlJob,
        pendingShortcodes: batch.pendingShortcodes,
        nextCursor: batch.nextCursor,
        hasMore: false,
        status: "completed",
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
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
      await saveCrawlJob(crawlJob);
      await setBadge(tabId, "OK", BADGE_COLORS.success, `Full crawl complete for @${crawlJob.username}`);
      clearBadgeSoon(tabId, tabUrl);
      return {
        ok: true,
        crawlJob: summarizeCrawlJob(crawlJob),
        result: {
          downloaded: 0,
          skipped: 0,
          failed: 0
        }
      };
    }

    const batchPlanResult = await resolveProfileBatchPlanFromShortcodes(tabUrl, crawlJob, batch.shortcodes, settings, async (progress) => {
      await setBadge(tabId, `${progress.current}/${progress.total}`, BADGE_COLORS.working, `Crawling @${crawlJob.username} ${progress.current}/${progress.total}`);
      if (progress.shouldNotify) {
        await sendToast(tabId, `Crawling @${crawlJob.username}: ${progress.current}/${progress.total} posts...`, "info");
      }
    });

    const plan = {
      ...batchPlanResult,
      meta: {
        ...batchPlanResult.meta,
        batchDiagnostics: [
          `Processed ${batch.shortcodes.length} profile post${batch.shortcodes.length === 1 ? "" : "s"} in this crawl batch.`,
          batch.stopReason === "crawl_completed"
            ? "Reached the end of profile pagination in this run."
            : "Batch limit reached. Resume the crawl to continue from the saved cursor."
        ]
      }
    };

    let result;
    if (plan.items.length > 0) {
      if (settings.confirmBeforeDownload) {
        const confirmed = await requestDownloadConfirmation(tabId, plan);
        if (!confirmed) {
          crawlJob = {
            ...crawlJob,
            status: "paused",
            updatedAt: new Date().toISOString(),
            pendingShortcodes: batch.pendingShortcodes,
            nextCursor: batch.nextCursor,
            hasMore: batch.hasMore,
            lastBatch: {
              processedPosts: batch.shortcodes.length,
              resolvedMedia: plan.items.length,
              queued: 0,
              skipped: 0,
              failed: 0,
              pagesFetched: batch.pagesFetched,
              stopReason: "cancelled_before_download"
            }
          };
          await saveCrawlJob(crawlJob);
          await setBadge(tabId, "CAN", BADGE_COLORS.error, "Full crawl paused");
          clearBadgeSoon(tabId, tabUrl, 2200);
          return {
            ok: false,
            cancelled: true,
            crawlJob: summarizeCrawlJob(crawlJob)
          };
        }
      }

      result = await queueDownloads(plan, settings);
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
          logWarn("full_crawl_batch_report_failed", {
            error: toErrorDetails(err)
          });
        }
      }

      await recordDownloadHistory(plan, result);
    } else {
      result = {
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

    crawlJob = {
      ...crawlJob,
      pendingShortcodes: batch.pendingShortcodes,
      nextCursor: batch.nextCursor,
      hasMore: batch.hasMore,
      status: batch.hasMore ? "paused" : "completed",
      updatedAt: new Date().toISOString(),
      completedAt: batch.hasMore ? null : new Date().toISOString(),
      batchesCompleted: Number(crawlJob.batchesCompleted || 0) + 1,
      totalPostsResolved: Number(crawlJob.totalPostsResolved || 0) + batch.shortcodes.length,
      totalFailedPosts: Number(crawlJob.totalFailedPosts || 0) + Number(batchPlanResult.failedPosts?.length || 0),
      totalMediaQueued: Number(crawlJob.totalMediaQueued || 0) + Number(result.downloaded || 0),
      totalMediaSkipped: Number(crawlJob.totalMediaSkipped || 0) + Number(result.skipped || 0),
      totalMediaFailed: Number(crawlJob.totalMediaFailed || 0) + Number(result.failed || 0),
      lastError: null,
      lastBatch: {
        processedPosts: batch.shortcodes.length,
        resolvedMedia: plan.items.length,
        queued: result.downloaded || 0,
        skipped: result.skipped || 0,
        failed: result.failed || 0,
        pagesFetched: batch.pagesFetched,
        stopReason: batch.stopReason
      }
    };
    await saveCrawlJob(crawlJob);

    const continuationText = batch.hasMore ? "Resume to continue from the saved cursor." : "Full profile crawl completed.";
    await setBadge(tabId, "OK", BADGE_COLORS.success, continuationText);
    await sendToast(tabId, continuationText, "success");
    clearBadgeSoon(tabId, tabUrl);

    return {
      ok: true,
      crawlJob: summarizeCrawlJob(crawlJob),
      result
    };
  } catch (err) {
    crawlJob = {
      ...crawlJob,
      status: "error",
      updatedAt: new Date().toISOString(),
      lastError: toErrorDetails(err).message
    };
    await saveCrawlJob(crawlJob);
    throw err;
  }
}

async function requestDownloadConfirmation(tabId, plan) {
  await ensureContentScript(tabId);

  const response = await chrome.tabs.sendMessage(tabId, {
    type: "CONFIRM_DOWNLOAD",
    summary: buildSummary(plan)
  });

  return response?.confirmed === true;
}

async function runDownloadFlow(tab, mode) {
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

  try {
    const settings = await getSettings();
    clearPreviewCacheForUrl(tabUrl);
    await setBadge(tabId, "...", BADGE_COLORS.working, "Resolving Instagram media...");
    await sendToast(tabId, "Resolving Instagram media via the authenticated API...", "info");

    const resolvedPlan = await resolveDownloadPlan(tabUrl, settings, async (progress) => {
      await setBadge(tabId, `${progress.current}/${progress.total}`, BADGE_COLORS.working, `Resolving profile posts ${progress.current}/${progress.total}`);
      if (progress.shouldNotify) {
        await sendToast(tabId, `Resolving profile posts ${progress.current}/${progress.total}...`, "info");
      }
    });
    const diagnosticPlan = {
      ...resolvedPlan,
      meta: {
        ...resolvedPlan.meta,
        batchDiagnostics: buildProfileBatchDiagnostics(resolvedPlan.meta)
      }
    };
    const plan = await enrichPlanMetadata(diagnosticPlan, tabUrl, settings);
    logInfo("plan_resolved", {
      mode,
      tabUrl,
      pageKind: plan.meta.pageKind,
      source: plan.meta.source,
      itemCount: plan.items.length
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

    const metadataNote = result.metadata ? " Metadata sidecar saved." : "";
    const skippedNote = result.skipped ? ` Skipped ${result.skipped} already-downloaded file${result.skipped === 1 ? "" : "s"}.` : "";
    const successMessage = result.alreadyDownloaded
      ? `All files were already downloaded.${skippedNote}`
      : result.downloaded === 1
        ? `Download started.${metadataNote}${skippedNote}`
        : `Downloads started: ${result.downloaded}/${result.requested}.${metadataNote}${skippedNote}`;

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

    return {
      ok: true,
      result,
      preview: buildPlanPreview(plan, settings, await getKnownDownloadKeys())
    };
  } catch (err) {
    const details = toErrorDetails(err);
    const presentation = getErrorPresentation(err);
    if (err instanceof InstagramResolverError) {
      logWarn("download_flow_failed", {
        mode,
        tabUrl,
        error: presentation
      });
    } else {
      logError("download_flow_failed", err, { mode, tabUrl });
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

chrome.action.onClicked.addListener(async (tab) => {
  const settings = await getSettings();
  if (!settings.easyMode) {
    return;
  }

  await runDownloadFlow(tab, "action_click");
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === MENU_ID_PAGE) {
    await runDownloadFlow(tab, "context_page");
  }
});

chrome.runtime.onStartup.addListener(() => {
  syncActionPresentation().catch((err) => {
    logWarn("action_presentation_startup_failed", {
      error: toErrorDetails(err)
    });
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") {
    return;
  }

  previewCache.clear();

  if (changes.easyMode) {
    syncActionPresentation().catch((err) => {
      logWarn("action_presentation_sync_failed", {
        error: toErrorDetails(err)
      });
    });
    return;
  }

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (chrome.runtime.lastError) {
      return;
    }

    const [activeTab] = tabs || [];
    if (activeTab?.id) {
      scheduleAvailabilityBadgeRefresh(activeTab);
    }
  });
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    scheduleAvailabilityBadgeRefresh(tab);
  } catch (err) {
    logWarn("tab_activation_badge_failed", {
      tabId,
      error: toErrorDetails(err)
    });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== "complete") {
    return;
  }

  scheduleAvailabilityBadgeRefresh({
    id: tabId,
    url: tab.url || changeInfo.url || ""
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTimeout(badgeRefreshTimers.get(tabId));
  badgeRefreshTimers.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type) {
    return false;
  }

  if (message.type === "GET_PAGE_PREVIEW") {
    getPagePreview({ id: message.tabId, url: message.tabUrl })
      .then((preview) => sendResponse(preview))
      .catch((err) => sendResponse({ ok: false, error: getErrorPresentation(err) }));
    return true;
  }

  if (message.type === "GET_DOWNLOAD_HISTORY") {
    getDownloadHistory()
      .then((history) => sendResponse(history))
      .catch((err) => sendResponse({ ok: false, error: getErrorPresentation(err) }));
    return true;
  }

  if (message.type === "GET_PROFILE_CRAWL_STATUS") {
    getProfileCrawlStatus({ id: message.tabId, url: message.tabUrl })
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: getErrorPresentation(err) }));
    return true;
  }

  if (message.type === "EXPORT_DOWNLOAD_HISTORY") {
    exportDownloadHistory()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: getErrorPresentation(err) }));
    return true;
  }

  if (message.type === "CLEAR_DOWNLOAD_HISTORY") {
    clearDownloadHistory()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: getErrorPresentation(err) }));
    return true;
  }

  if (message.type === "START_FULL_PROFILE_CRAWL") {
    runFullProfileCrawl({ id: message.tabId, url: message.tabUrl })
      .then((result) => sendResponse(result || { ok: false }))
      .catch((err) => sendResponse({ ok: false, error: getErrorPresentation(err) }));
    return true;
  }

  if (message.type === "RESET_FULL_PROFILE_CRAWL") {
    resetFullProfileCrawl({ id: message.tabId, url: message.tabUrl })
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: getErrorPresentation(err) }));
    return true;
  }

  if (message.type === "START_PAGE_DOWNLOAD") {
    runDownloadFlow({ id: message.tabId, url: message.tabUrl }, "popup_download")
      .then((result) => sendResponse(result || { ok: false }))
      .catch((err) => sendResponse({ ok: false, error: getErrorPresentation(err) }));
    return true;
  }

  return false;
});

syncActionPresentation().catch((err) => {
  logWarn("action_presentation_bootstrap_failed", {
    error: toErrorDetails(err)
  });
});
