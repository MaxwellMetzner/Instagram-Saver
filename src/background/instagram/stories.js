import { InstagramResolverError, isRateLimitError, toErrorDetails } from "../core/errors.js";
import { logWarn } from "../core/logger.js";
import { sleep, uniqBy } from "../core/utils.js";
import {
  INSTAGRAM_WEB_API_BASE_URL,
  fetchJsonWithTimeout,
  getInstagramApiHeaders,
  getRequestEndpoint
} from "./api.js";
import { extractOwner, hasCompleteStoryItems, normalizeStoryEntry } from "./media.js";
import { extractStoryPageData } from "./page-data.js";
import { fetchStoryPageReels } from "./story-page-api.js";
import { getProfilePageFetchUrl } from "./urls.js";

async function lookupUserIdByUsername(username, tabUrl) {
  const url = new URL(`${INSTAGRAM_WEB_API_BASE_URL}/users/web_profile_info/`);
  url.searchParams.set("username", username);
  const data = await fetchJsonWithTimeout(url.href, {
    headers: getInstagramApiHeaders(getProfilePageFetchUrl(tabUrl, username))
  });

  const userId = data?.data?.user?.id || data?.data?.user?.pk;
  if (!userId) {
    throw new InstagramResolverError("user_lookup_failed", "Could not resolve the Instagram user for this story.", {
      username
    });
  }

  return String(userId);
}

function buildStoryPlan(reel, descriptor, source) {
  const reelItems = Array.isArray(reel?.items) ? reel.items : [];
  const owner = extractOwner(reel?.user ? { user: reel.user } : reel);

  if (!reelItems.length) {
    throw new InstagramResolverError(
      "story_not_found",
      descriptor.kind === "story"
        ? "Instagram did not return any current stories for this account."
        : "The requested story item was not returned by Instagram.",
      { descriptor }
    );
  }
  if (!hasCompleteStoryItems(reel)) {
    throw new InstagramResolverError("story_incomplete", "Instagram returned only part of the story list.", {
      descriptor, source
    });
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
    timestamp: Number(reelItems[0]?.taken_at || 0) || null,
    source
  };

  const items = reelItems.map((item, index) => normalizeStoryEntry(item, meta, index));

  if (items.some((item) => !item)) {
    throw new InstagramResolverError(
      "story_incomplete",
      "Instagram returned story metadata without downloadable media for every item.",
      { descriptor, source }
    );
  }

  return {
    meta,
    items: uniqBy(items, (item) => item.mediaId)
  };
}

async function fetchStoryMediaInfo(storyPk, tabUrl) {
  const url = `${INSTAGRAM_WEB_API_BASE_URL}/media/${encodeURIComponent(storyPk)}/info/`;
  const data = await fetchJsonWithTimeout(url, {
    headers: getInstagramApiHeaders(tabUrl),
    requestLabel: "story_media_info"
  });
  const story = data?.items?.find((item) => String(item?.pk || item?.id || "").split("_")[0] === String(storyPk));

  if (!story) {
    throw new InstagramResolverError(
      "story_unavailable",
      "Instagram did not return the requested story frame. Check that it is still available and visible in your account.",
      { storyPk, url }
    );
  }

  return story;
}

async function retryStoryRequest(request, retryNotFound = false) {
  try {
    return await request();
  } catch (err) {
    const details = toErrorDetails(err);
    const status = Number(details.context?.status || 0);
    const transient = status >= 500 && status < 600 ||
      ["timeout", "network_error", "story_page_not_ready"].includes(details.code) ||
      err instanceof TypeError || retryNotFound && status === 404;
    if (!transient || isRateLimitError(err)) throw err;
    logWarn("story_request_retry", { error: details });
    await sleep(500);
    return request();
  }
}

function findStoryReel(reels, descriptor, userId) {
  return reels.find((reel) => {
    const id = String(reel?.id || reel?.pk || reel?.reel_id || "");
    if (descriptor.kind === "highlight") {
      return id === `highlight:${descriptor.highlightId}` || id === String(descriptor.highlightId);
    }
    if (id.startsWith("highlight:") || reel?.reel_type === "highlight_reel") return false;
    const owner = reel?.user || reel?.owner;
    const username = String(owner?.username || "").toLowerCase();
    if (username && username !== descriptor.username.toLowerCase()) return false;
    return id === String(userId) || String(owner?.pk || owner?.id || "") === String(userId);
  });
}

export async function resolveStoryPlan(tabUrl, descriptor, tabId = null) {
  const diagnostics = [];
  let lastError = null;
  async function attempt(label, operation) {
    try {
      return await operation();
    } catch (err) {
      if (isRateLimitError(err)) throw err;
      lastError = toErrorDetails(err);
      diagnostics.push(`${label}: ${lastError.message}`);
      logWarn("story_resolution_attempt_failed", { descriptor, stage: label, error: lastError });
      return null;
    }
  }

  function finish(reel, source) {
    const plan = buildStoryPlan(reel, descriptor, source);
    return {
      ...plan,
      meta: { ...plan.meta, pageUrl: tabUrl, diagnostics: [...diagnostics] }
    };
  }

  async function readPage() {
    return tabId ? attempt("Active-page story extraction", () => extractStoryPageData(
      tabId, descriptor.username || "", descriptor.highlightId || null
    )) : null;
  }

  let pageData = await readPage();
  if (pageData?.storyReel) {
    const plan = await attempt("Embedded story list", () => finish(pageData.storyReel, "instagram_story_page_data"));
    if (plan) return plan;
  }

  let userId = pageData?.user?.id || pageData?.user?.pk || null;
  if (descriptor.kind === "story" && !userId) {
    // Media-info identifies the owner; its single frame is never a complete story list.
    if (descriptor.storyPk) {
      const story = await attempt("Story owner from media info", () =>
        retryStoryRequest(() => fetchStoryMediaInfo(descriptor.storyPk, tabUrl)));
      if (String(story?.user?.username || "").toLowerCase() === descriptor.username.toLowerCase()) {
        userId = story.user.pk || story.user.id;
      }
    }
    if (!userId) {
      userId = await attempt("Story owner lookup", () =>
        retryStoryRequest(() => lookupUserIdByUsername(descriptor.username, tabUrl), true));
    }
  }
  if (userId) userId = String(userId);

  if (tabId && (descriptor.kind === "highlight" || userId)) {
    const plan = await attempt("Instagram page story query", async () => {
      const reels = await retryStoryRequest(() => fetchStoryPageReels(tabId, descriptor, userId));
      const reel = findStoryReel(reels, descriptor, userId);
      if (!reel) return null;
      return finish(reel, "instagram_story_page_graphql");
    });
    if (plan) return plan;
  }

  const reelIds = descriptor.kind === "highlight"
    ? [`highlight:${descriptor.highlightId}`, String(descriptor.highlightId)]
    : userId ? [userId] : [];
  for (const reelId of reelIds) {
    const reelsUrl = new URL(`${INSTAGRAM_WEB_API_BASE_URL}/feed/reels_media/`);
    reelsUrl.searchParams.set("reel_ids", reelId);
    const plan = await attempt(getRequestEndpoint(reelsUrl.href), async () => {
      const data = await retryStoryRequest(() => fetchJsonWithTimeout(reelsUrl.href, {
        headers: getInstagramApiHeaders(tabUrl),
        requestLabel: descriptor.kind === "highlight"
          ? `highlight_reels_media:${reelId}`
          : "story_reels_media"
      }));
      const reels = Array.isArray(data?.reels_media)
        ? data.reels_media
        : Object.entries(data?.reels || {}).map(([id, reel]) => ({ ...reel, id: reel?.id || reel?.pk || id }));
      const reel = findStoryReel(reels, descriptor, userId);
      if (!reel) {
        diagnostics.push(`Endpoint returned no reel for ${reelId}.`);
        return null;
      }
      return finish(reel, "instagram_api_reels_media");
    });
    if (plan) return plan;
  }

  // A click during navigation can race both page hydration and the fallback requests.
  pageData = await readPage();
  if (pageData?.storyReel) {
    const plan = await attempt("Updated page story list", () => finish(pageData.storyReel, "instagram_story_page_data"));
    if (plan) return plan;
  }
  if (lastError) {
    throw new InstagramResolverError(
      "story_load_failed",
      "Instagram did not return the full story or highlight list. No partial list will be downloaded.",
      { ...lastError.context, tabUrl, descriptor, diagnostics }
    );
  }

  throw new InstagramResolverError(
    "story_unavailable",
    "Instagram did not return story data for this page. Check that the story or highlight is still available and visible in your account.",
    { tabUrl, descriptor, diagnostics }
  );
}
