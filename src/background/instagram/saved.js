import { InstagramResolverError, isRateLimitError, toErrorDetails } from "../core/errors.js";
import { logWarn } from "../core/logger.js";
import { uniqBy } from "../core/utils.js";
import { INSTAGRAM_WEB_API_BASE_URL, fetchJsonWithTimeout, getInstagramApiHeaders } from "./api.js";
import { resolvePostPlan } from "./posts.js";
import { extractShortcodesFromProfileFeedResponse } from "./profiles.js";
import { applyProfileMediaFilter, formatProfileMediaFilterLabel, shouldReportProfileProgress } from "../plans/batch.js";

export async function fetchSavedPostsPage(collectionId, afterCursor, tabUrl, pageSize = 12) {
  const endpoint = collectionId
    ? `${INSTAGRAM_WEB_API_BASE_URL}/feed/collection/${encodeURIComponent(collectionId)}/posts/`
    : `${INSTAGRAM_WEB_API_BASE_URL}/feed/saved/posts/`;
  const feedUrl = new URL(endpoint);
  feedUrl.searchParams.set("count", String(pageSize));
  if (afterCursor) {
    feedUrl.searchParams.set("max_id", afterCursor);
  }

  const data = await fetchJsonWithTimeout(feedUrl.href, {
    headers: getInstagramApiHeaders(tabUrl)
  });

  const shortcodes = extractShortcodesFromProfileFeedResponse(data);
  const nextCursor = data?.next_max_id || data?.next_cursor || null;
  return {
    shortcodes,
    nextCursor,
    hasNextPage: Boolean(data?.more_available || nextCursor)
  };
}

export async function resolveSavedPlan(tabUrl, descriptor, settings, progressCallback = null) {
  const timeline = await fetchSavedPostsPage(
    descriptor.collectionId,
    null,
    tabUrl,
    Math.min(12, settings.maxProfilePosts)
  );
  const shortcodes = [...timeline.shortcodes];
  let cursor = timeline.nextCursor;
  let hasNextPage = timeline.hasNextPage;
  let pagesFetched = 1;

  while (
    shortcodes.length < settings.maxProfilePosts &&
    hasNextPage &&
    cursor &&
    pagesFetched < 8
  ) {
    const page = await fetchSavedPostsPage(
      descriptor.collectionId,
      cursor,
      tabUrl,
      Math.min(12, settings.maxProfilePosts - shortcodes.length)
    );
    shortcodes.push(...page.shortcodes);
    cursor = page.nextCursor;
    hasNextPage = page.hasNextPage;
    pagesFetched += 1;
  }

  const uniqueShortcodes = Array.from(new Set(shortcodes)).slice(0, settings.maxProfilePosts);
  if (!uniqueShortcodes.length) {
    throw new InstagramResolverError(
      "saved_posts_empty",
      "Instagram did not return any posts for this saved page.",
      { username: descriptor.username, collectionId: descriptor.collectionId }
    );
  }

  const aggregatedItems = [];
  const failedPosts = [];
  for (let index = 0; index < uniqueShortcodes.length; index += 1) {
    const shortcode = uniqueShortcodes[index];
    if (progressCallback) {
      await progressCallback({
        current: index + 1,
        total: uniqueShortcodes.length,
        shortcode,
        shouldNotify: shouldReportProfileProgress(index + 1, uniqueShortcodes.length)
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
        throw err;
      }
      failedPosts.push({ shortcode, error: toErrorDetails(err) });
      logWarn("saved_post_resolution_failed", {
        shortcode,
        error: toErrorDetails(err)
      });
    }
  }

  const unfilteredItems = uniqBy(aggregatedItems, (item) => item.url);
  if (!unfilteredItems.length) {
    throw new InstagramResolverError(
      "saved_posts_unavailable",
      "The saved page returned posts, but none could be resolved into downloadable media.",
      { username: descriptor.username, collectionId: descriptor.collectionId, failedPosts }
    );
  }

  const filteredItems = applyProfileMediaFilter(unfilteredItems, settings.profileMediaFilter);
  if (!filteredItems.length) {
    throw new InstagramResolverError(
      "profile_filter_empty",
      `The saved page returned media, but none matched the selected media filter: ${formatProfileMediaFilterLabel(settings.profileMediaFilter)}.`,
      { username: descriptor.username, profileMediaFilter: settings.profileMediaFilter }
    );
  }

  const collectionLabel = descriptor.collectionId ? "Saved collection" : "All saved posts";
  const collectionKey = descriptor.collectionId || "all";
  return {
    meta: {
      id: `saved-${collectionKey}`,
      username: descriptor.username,
      displayName: collectionLabel,
      ownerId: null,
      pageKind: "saved",
      title: `${collectionLabel} (@${descriptor.username})`,
      caption: null,
      pageUrl: tabUrl,
      timestamp: null,
      source: "instagram_saved_posts_batch",
      profilePostCount: uniqueShortcodes.length,
      failedPostCount: failedPosts.length,
      profileMediaFilter: settings.profileMediaFilter,
      unfilteredItemCount: unfilteredItems.length,
      filteredItemCount: filteredItems.length,
      pagination: {
        initialCount: timeline.shortcodes.length,
        additionalCount: Math.max(0, uniqueShortcodes.length - timeline.shortcodes.length),
        pagesFetched,
        stopReason: uniqueShortcodes.length >= settings.maxProfilePosts
          ? "requested_limit_reached"
          : hasNextPage && cursor
            ? "iteration_cap"
            : "instagram_reported_end",
        error: null,
        source: "instagram_saved_feed"
      }
    },
    items: filteredItems
  };
}
