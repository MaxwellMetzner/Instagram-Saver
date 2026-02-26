const MENU_ID_IMAGE = "save-instagram-highest-quality-image";
const MENU_ID_VIDEO = "save-instagram-highest-quality-video";
const MENU_ID_POST = "save-instagram-post-media";
const LOG_PREFIX = "[InstagramSaver]";
const BADGE_COLORS = {
  working: "#1D4ED8",
  success: "#15803D",
  error: "#B91C1C"
};
const TAB_MEDIA_CACHE_TTL_MS = 15 * 60 * 1000;
const TAB_MEDIA_CACHE_LIMIT = 80;
const tabMediaCache = new Map();
const INSTAGRAM_SHORTCODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const INSTAGRAM_GRAPHQL_DOC_ID = "8845758582119845";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID_IMAGE,
    title: "Save highest-quality Instagram image",
    contexts: ["image"],
    documentUrlPatterns: ["https://*.instagram.com/*"]
  });

  chrome.contextMenus.create({
    id: MENU_ID_VIDEO,
    title: "Save Instagram video",
    contexts: ["video"],
    documentUrlPatterns: ["https://*.instagram.com/*"]
  });

  chrome.contextMenus.create({
    id: MENU_ID_POST,
    title: "Save media from this post",
    contexts: ["page"],
    documentUrlPatterns: ["https://*.instagram.com/*"]
  });
});

function guessExtension(url) {
  try {
    const u = new URL(url);

    // Instagram often serves jpg via query transforms even if path ends in .heic
    const stp = (u.searchParams.get("stp") || "").toLowerCase();

    if (stp.includes("dst-jpg")) return "jpg";
    if (stp.includes("dst-webp")) return "webp";
    if (stp.includes("dst-png")) return "png";

    const file = u.pathname.split("/").pop() || "";
    const m = file.match(/\.([a-z0-9]+)$/i);
    if (m) return m[1].toLowerCase();
  } catch {
    // ignore
  }

  return null;
}

function sanitizeFilenamePart(s) {
  return String(s).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}

function toErrorDetails(err) {
  if (!err) return { message: "Unknown error" };
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

function logInfo(event, context = {}) {
  console.info(`${LOG_PREFIX} ${event}`, context);
}

function logWarn(event, context = {}) {
  console.warn(`${LOG_PREFIX} ${event}`, context);
}

function logError(event, err, context = {}) {
  console.error(`${LOG_PREFIX} ${event}`, {
    ...context,
    error: toErrorDetails(err)
  });
}

function isInstagramUrl(url) {
  try {
    const host = new URL(url || "").hostname.toLowerCase();
    return host === "instagram.com" || host.endsWith(".instagram.com");
  } catch {
    return false;
  }
}

async function setBadge(tabId, text, color, title) {
  if (!tabId) return;

  try {
    await chrome.action.setBadgeBackgroundColor({
      tabId,
      color
    });

    await chrome.action.setBadgeText({
      tabId,
      text
    });

    if (title) {
      await chrome.action.setTitle({
        tabId,
        title
      });
    }
  } catch (err) {
    logWarn("badge_set_failed", {
      tabId,
      text,
      error: String(err)
    });
  }
}

function clearBadgeSoon(tabId, delayMs = 3500) {
  if (!tabId) return;

  setTimeout(async () => {
    try {
      await chrome.action.setBadgeText({ tabId, text: "" });
      await chrome.action.setTitle({
        tabId,
        title: "Download media from this Instagram post"
      });
    } catch (err) {
      logWarn("badge_clear_failed", { tabId, error: String(err) });
    }
  }, delayMs);
}

async function sendToast(tabId, message, level = "info") {
  if (!tabId) return;

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "SHOW_STATUS_TOAST",
      message,
      level
    });
  } catch (err) {
    logWarn("toast_send_failed", {
      tabId,
      message,
      error: String(err)
    });
  }
}

async function requestDownloadConfirmation(tabId, urls, metadata) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "CONFIRM_DOWNLOAD",
      urls,
      meta: metadata || {}
    });

    return response?.confirmed === true;
  } catch (err) {
    logWarn("confirm_prompt_failed", {
      tabId,
      error: String(err)
    });
    throw new Error("Could not show confirmation prompt.");
  }
}

function isMissingReceiverError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    msg.includes("receiving end does not exist") ||
    msg.includes("could not establish connection")
  );
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

  logInfo("inject_content_script", { tabId });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });

  const readyAfterInject = await pingContentScript(tabId);
  if (!readyAfterInject) {
    throw new Error("Content script did not respond after injection.");
  }
}

function inferMediaType(url) {
  const lower = String(url || "").toLowerCase();

  if (/(\.mp4|\.webm|\.mov|\.m4v)(\?|$)/.test(lower)) return "video";
  if (/\/v\/t16\//i.test(lower)) return "video";
  if (/\bvideo\b/i.test(lower)) return "video";

  try {
    const mimeType = (new URL(url).searchParams.get("mime_type") || "").toLowerCase();
    if (mimeType.startsWith("video/")) return "video";
  } catch {
    // ignore URL parse issues
  }

  return "image";
}

function isLikelyInstagramCdnUrl(url) {
  return /(cdninstagram\.com|fbcdn\.net)/i.test(String(url || ""));
}

function isLikelyVideoChunkUrl(url) {
  const lower = String(url || "").toLowerCase();
  if (!lower) return true;
  if (/\.m4s(\?|$)/.test(lower)) return true;
  if (/[?&](bytestart|byteend|range)=/i.test(lower)) return true;
  return false;
}

function isLikelyVideoUrl(url) {
  const lower = String(url || "").toLowerCase();
  if (!lower) return false;

  if (/(\.mp4|\.webm|\.mov|\.m4v)(\?|$)/.test(lower)) return true;
  if (/\/v\/t16\//i.test(lower)) return true;
  if (/-16\//i.test(lower)) return true;
  if (/\bvideo\b/i.test(lower)) return true;

  try {
    const mimeType = (new URL(url).searchParams.get("mime_type") || "").toLowerCase();
    if (mimeType.startsWith("video/")) return true;
  } catch {
    // ignore parse errors
  }

  return false;
}

function ensureTabMediaCache(tabId) {
  let entry = tabMediaCache.get(tabId);
  if (!entry) {
    entry = {
      videos: [],
      images: [],
      updatedAt: Date.now()
    };
    tabMediaCache.set(tabId, entry);
  }
  return entry;
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

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

function getLargestImageCandidateUrl(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  const sorted = [...candidates].sort((a, b) => {
    const aPixels = Number(a?.width || 0) * Number(a?.height || 0);
    const bPixels = Number(b?.width || 0) * Number(b?.height || 0);
    return bPixels - aPixels;
  });

  return sorted[0]?.url || null;
}

function getLargestVideoVersionUrl(videoVersions) {
  if (!Array.isArray(videoVersions) || videoVersions.length === 0) return null;

  const sorted = [...videoVersions].sort((a, b) => {
    const aPixels = Number(a?.width || 0) * Number(a?.height || 0);
    const bPixels = Number(b?.width || 0) * Number(b?.height || 0);
    return bPixels - aPixels;
  });

  return sorted[0]?.url || null;
}

function normalizeApiMediaUrl(url) {
  if (!url) return null;
  try {
    return new URL(url).href;
  } catch {
    return null;
  }
}

function collectUrlsFromApiMediaNode(node, outUrls) {
  if (!node || typeof node !== "object") return;

  const bestVideo = normalizeApiMediaUrl(node.video_url || getLargestVideoVersionUrl(node.video_versions));
  const bestImage = normalizeApiMediaUrl(
    node.display_url || getLargestImageCandidateUrl(node?.image_versions2?.candidates)
  );

  if (bestVideo && isLikelyInstagramCdnUrl(bestVideo)) {
    outUrls.push(bestVideo);
  }

  if (bestImage && isLikelyInstagramCdnUrl(bestImage)) {
    outUrls.push(bestImage);
  }

  const carousel = Array.isArray(node.carousel_media) ? node.carousel_media : [];
  for (const item of carousel) {
    collectUrlsFromApiMediaNode(item, outUrls);
  }
}

function uniqUrls(urls) {
  const seen = new Set();
  const result = [];
  for (const url of urls) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    result.push(url);
  }
  return result;
}

function extractMetaFromApiMedia(media, fallbackShortcode) {
  return {
    username: media?.user?.username || media?.owner?.username || "instagram",
    shortcode: media?.code || fallbackShortcode || "post"
  };
}

async function resolveInstagramMediaViaApi(tabUrl) {
  const shortcode = extractShortcodeFromUrl(tabUrl);
  if (!shortcode) return null;

  const pk = instagramShortcodeToPk(shortcode);
  if (!pk) return null;

  const headers = getInstagramApiHeaders(tabUrl);

  try {
    await fetchJsonWithTimeout(
      `https://i.instagram.com/api/v1/web/get_ruling_for_content/?content_type=MEDIA&target_id=${encodeURIComponent(pk)}`,
      {
        credentials: "include",
        headers
      },
      8000
    );
  } catch {
    // session bootstrap is best effort
  }

  try {
    const infoData = await fetchJsonWithTimeout(
      `https://i.instagram.com/api/v1/media/${encodeURIComponent(pk)}/info/`,
      {
        credentials: "include",
        headers
      }
    );

    const media = Array.isArray(infoData?.items) ? infoData.items[0] : null;
    if (media) {
      const urls = [];
      collectUrlsFromApiMediaNode(media, urls);
      const resolved = uniqUrls(urls).filter((url) => !isLikelyVideoChunkUrl(url));

      if (resolved.length) {
        return {
          ok: true,
          urls: resolved,
          meta: extractMetaFromApiMedia(media, shortcode),
          source: "instagram_api_media_info"
        };
      }
    }
  } catch (err) {
    logWarn("api_media_info_failed", {
      tabUrl,
      shortcode,
      error: String(err)
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

    const graphqlData = await fetchJsonWithTimeout(
      graphqlUrl.href,
      {
        credentials: "include",
        headers
      }
    );

    const media = graphqlData?.data?.xdt_shortcode_media || null;
    if (media) {
      const urls = [];
      collectUrlsFromApiMediaNode(media, urls);
      const resolved = uniqUrls(urls).filter((url) => !isLikelyVideoChunkUrl(url));

      if (resolved.length) {
        return {
          ok: true,
          urls: resolved,
          meta: extractMetaFromApiMedia(media, shortcode),
          source: "instagram_api_graphql"
        };
      }
    }
  } catch (err) {
    logWarn("api_graphql_failed", {
      tabUrl,
      shortcode,
      error: String(err)
    });
  }

  return null;
}

function pickBestByType(urls, type) {
  const list = Array.isArray(urls) ? urls.filter(Boolean) : [];
  if (!list.length) return null;

  if (type === "video") {
    return list.find((url) => inferMediaType(url) === "video") || list[0] || null;
  }

  return list.find((url) => inferMediaType(url) === "image") || list[0] || null;
}

async function getPostMediaApiFirst(tabId, tabUrl) {
  const apiResponse = await resolveInstagramMediaViaApi(tabUrl);
  if (apiResponse?.ok && Array.isArray(apiResponse.urls) && apiResponse.urls.length) {
    logInfo("media_resolved_api", {
      tabId,
      tabUrl,
      source: apiResponse.source,
      count: apiResponse.urls.length
    });
    return apiResponse;
  }

  return getMediaFromTab(tabId, "GET_POST_MEDIA");
}

async function getBestVideoApiFirst(tabId, tabUrl, fallbackSrcUrl) {
  const apiResponse = await resolveInstagramMediaViaApi(tabUrl);
  const apiBest = pickBestByType(apiResponse?.urls, "video");
  if (apiBest) {
    return {
      ok: true,
      url: apiBest,
      meta: apiResponse.meta || {}
    };
  }

  return getMediaFromTab(tabId, "GET_BEST_VIDEO_URL", { fallbackSrcUrl });
}

async function getBestImageApiFirst(tabId, tabUrl, fallbackSrcUrl) {
  const apiResponse = await resolveInstagramMediaViaApi(tabUrl);
  const apiBest = pickBestByType(apiResponse?.urls, "image");
  if (apiBest) {
    return {
      ok: true,
      url: apiBest,
      meta: apiResponse.meta || {}
    };
  }

  return getMediaFromTab(tabId, "GET_BEST_IMAGE_URL", { fallbackSrcUrl });
}

function pushUniqueLimited(list, url, limit) {
  if (!url) return;
  const existingIndex = list.indexOf(url);
  if (existingIndex !== -1) {
    list.splice(existingIndex, 1);
  }
  list.push(url);
  if (list.length > limit) {
    list.splice(0, list.length - limit);
  }
}

function rememberMediaUrl(tabId, url, type) {
  if (!tabId || tabId < 0 || !url || !isLikelyInstagramCdnUrl(url)) return;

  if (type === "video") {
    if (!isLikelyVideoUrl(url) || isLikelyVideoChunkUrl(url)) return;
  }

  const entry = ensureTabMediaCache(tabId);
  pushUniqueLimited(type === "video" ? entry.videos : entry.images, url, TAB_MEDIA_CACHE_LIMIT);
  entry.updatedAt = Date.now();
}

function getTabMediaHints(tabId) {
  if (!tabId || tabId < 0) {
    return { videos: [], images: [] };
  }

  const entry = tabMediaCache.get(tabId);
  if (!entry) {
    return { videos: [], images: [] };
  }

  if (Date.now() - entry.updatedAt > TAB_MEDIA_CACHE_TTL_MS) {
    tabMediaCache.delete(tabId);
    return { videos: [], images: [] };
  }

  return {
    videos: [...entry.videos].reverse(),
    images: [...entry.images].reverse()
  };
}

function buildFilename(url, metadata, index) {
  const mediaType = inferMediaType(url);
  const guessed = guessExtension(url);
  const ext = mediaType === "video" ? guessed || "mp4" : guessed || "jpg";
  const username = sanitizeFilenamePart(metadata?.username || "unknown");
  const shortcode = sanitizeFilenamePart(metadata?.shortcode || "post");
  const part = String(index + 1).padStart(2, "0");
  return `instagram/${username}_${shortcode}_${part}.${ext}`;
}

async function getMediaFromTab(tabId, requestType, payload = {}) {
  logInfo("request_media", { tabId, requestType });

  await ensureContentScript(tabId);

  const response = await chrome.tabs.sendMessage(tabId, {
    type: requestType,
    backgroundHints: getTabMediaHints(tabId),
    ...payload
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Could not resolve media URL.");
  }

  return response;
}

async function downloadUrls(urls, metadata) {
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new Error("No downloadable media found.");
  }

  let downloaded = 0;
  const failures = [];

  for (let i = 0; i < urls.length; i += 1) {
    const url = urls[i];
    const filename = buildFilename(url, metadata, i);

    try {
      const downloadId = await chrome.downloads.download({
        url,
        filename,
        saveAs: urls.length === 1
      });

      downloaded += 1;
      logInfo("download_queued", {
        index: i,
        downloadId,
        filename,
        url
      });
    } catch (err) {
      failures.push({ url, filename, error: toErrorDetails(err) });
      logError("download_queue_failed", err, {
        index: i,
        filename,
        url
      });
    }
  }

  if (downloaded === 0) {
    const firstFailure = failures[0]?.error?.message || "All downloads failed.";
    throw new Error(firstFailure);
  }

  return {
    requested: urls.length,
    downloaded,
    failed: failures.length,
    failures
  };
}

async function runDownloadFlow(tab, mode, resolver) {
  if (!tab?.id) return;

  const tabId = tab.id;
  const tabUrl = tab.url || "";

  if (!isInstagramUrl(tabUrl)) {
    await setBadge(tabId, "ERR", BADGE_COLORS.error, "Open an Instagram post first");
    await sendToast(tabId, "Open an Instagram post first.", "error");
    clearBadgeSoon(tabId);
    logWarn("invalid_tab_url", { mode, tabUrl });
    return;
  }

  try {
    await setBadge(tabId, "...", BADGE_COLORS.working, "Finding best media...");
    await sendToast(tabId, "Finding best-quality media...", "info");

    const response = await resolver(tabId, tabUrl);
    const urls = Array.isArray(response.urls) ? response.urls : [response.url].filter(Boolean);

    logInfo("media_resolved", {
      mode,
      tabId,
      count: urls.length,
      urls
    });

    const confirmed = await requestDownloadConfirmation(tabId, urls, response.meta || {});
    if (!confirmed) {
      await setBadge(tabId, "CAN", BADGE_COLORS.error, "Download cancelled");
      await sendToast(tabId, "Download cancelled.", "info");
      clearBadgeSoon(tabId, 2200);
      logInfo("download_cancelled", {
        mode,
        tabId,
        count: urls.length
      });
      return;
    }

    await setBadge(tabId, "DL", BADGE_COLORS.working, "Starting download...");
    const result = await downloadUrls(urls, response.meta || {});

    const successMsg =
      result.downloaded === 1
        ? "Download started."
        : `Downloads started: ${result.downloaded}/${result.requested}.`;

    await setBadge(tabId, "OK", BADGE_COLORS.success, successMsg);
    await sendToast(tabId, successMsg, "success");
    clearBadgeSoon(tabId);

    if (result.failed > 0) {
      logWarn("partial_download_failure", {
        mode,
        tabId,
        requested: result.requested,
        downloaded: result.downloaded,
        failures: result.failures
      });
    }
  } catch (err) {
    const details = toErrorDetails(err);
    logError("download_flow_failed", err, { mode, tabId, tabUrl });

    await setBadge(tabId, "ERR", BADGE_COLORS.error, details.message || "Download failed");
    await sendToast(tabId, `Failed: ${details.message || "Unknown error"}`, "error");
    clearBadgeSoon(tabId, 6000);
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  await runDownloadFlow(tab, "action_post", async (tabId, tabUrl) => {
    return getPostMediaApiFirst(tabId, tabUrl);
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;

  if (info.menuItemId === MENU_ID_IMAGE) {
    await runDownloadFlow(tab, "context_image", async (tabId, tabUrl) => {
      return getBestImageApiFirst(tabId, tabUrl, info.srcUrl || null);
    });
    return;
  }

  if (info.menuItemId === MENU_ID_VIDEO) {
    await runDownloadFlow(tab, "context_video", async (tabId, tabUrl) => {
      return getBestVideoApiFirst(tabId, tabUrl, info.srcUrl || null);
    });
    return;
  }

  if (info.menuItemId === MENU_ID_POST) {
    await runDownloadFlow(tab, "context_post", async (tabId, tabUrl) => {
      return getPostMediaApiFirst(tabId, tabUrl);
    });
  }
});

if (chrome.webRequest?.onCompleted) {
  chrome.webRequest.onCompleted.addListener(
    (details) => {
      const tabId = details?.tabId;
      const url = details?.url;

      if (!tabId || tabId < 0 || !url || !isLikelyInstagramCdnUrl(url)) return;

      if (isLikelyVideoUrl(url)) {
        rememberMediaUrl(tabId, url, "video");
      } else {
        rememberMediaUrl(tabId, url, "image");
      }
    },
    {
      urls: ["https://*.cdninstagram.com/*", "https://*.fbcdn.net/*"],
      types: ["media", "xmlhttprequest", "other"]
    }
  );
}

chrome.tabs.onRemoved.addListener((tabId) => {
  tabMediaCache.delete(tabId);
});