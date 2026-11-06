import { InstagramResolverError, isRateLimitError, toErrorDetails } from "../core/errors.js";
import { logWarn } from "../core/logger.js";
import { uniqBy } from "../core/utils.js";
import {
  INSTAGRAM_WEB_API_BASE_URL,
  fetchJsonWithTimeout,
  fetchTextWithTimeout,
  getInstagramApiHeaders
} from "./api.js";
import { extractInstagramPageData } from "./page-data.js";
import { resolvePostPlan } from "./posts.js";
import { getProfilePageFetchUrl } from "./urls.js";
import { applyProfileMediaFilter, formatProfileMediaFilterLabel, shouldReportProfileProgress } from "../plans/batch.js";

export async function fetchProfileInfo(username, tabUrl) {
  const url = new URL(`${INSTAGRAM_WEB_API_BASE_URL}/users/web_profile_info/`);
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

export function extractShortcodesFromProfileFeedResponse(data) {
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

export async function fetchProfileTimelinePage(userId, afterCursor, tabUrl, pageSize = 12) {
  const feedUrl = new URL(`${INSTAGRAM_WEB_API_BASE_URL}/feed/user/${encodeURIComponent(userId)}/`);
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

export async function getInitialProfileTimeline(profileInfo, tabUrl, requestedCount) {
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
      if (isRateLimitError(htmlErr)) {
        throw htmlErr;
      }

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
    if (isRateLimitError(err)) {
      throw err;
    }

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
      if (isRateLimitError(htmlErr)) {
        throw htmlErr;
      }

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
      if (isRateLimitError(err)) {
        throw err;
      }

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

export async function resolveProfilePlan(tabUrl, descriptor, settings, progressCallback = null, tabId = null) {
  const pageData = tabId
    ? await extractInstagramPageData(tabId, descriptor.username, settings.maxProfilePosts)
    : null;
  const pageShortcodes = pageData?.timeline?.shortcodes || [];
  const hasUsablePageData = Boolean(pageData?.user?.id || pageData?.user?.pk || pageShortcodes.length);
  const profileInfo = hasUsablePageData
    ? { user: pageData.user, raw: null }
    : await fetchProfileInfo(descriptor.username, tabUrl);
  const user = profileInfo.user;
  const initialTimeline = pageShortcodes.length
    ? {
      ...pageData.timeline,
      shortcodes: pageShortcodes,
      source: pageData.source
    }
    : await getInitialProfileTimeline(profileInfo, tabUrl, settings.maxProfilePosts);
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
      if (isRateLimitError(err)) {
        throw err;
      }

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
