import { InstagramResolverError, isRateLimitError, toErrorDetails } from "../core/errors.js";
import { logWarn } from "../core/logger.js";
import { uniqBy } from "../core/utils.js";
import {
  INSTAGRAM_GRAPHQL_DOC_ID,
  INSTAGRAM_WEB_API_BASE_URL,
  ensureInstagramSession,
  fetchJsonWithTimeout,
  getInstagramApiHeaders
} from "./api.js";
import {
  extractOwner,
  getCaptionText,
  getCarouselChildren,
  normalizePostEntry
} from "./media.js";
import { extractShortcodeFromUrl, instagramShortcodeToPk } from "./urls.js";

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

export async function resolvePostPlan(tabUrl, descriptor) {
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
      `${INSTAGRAM_WEB_API_BASE_URL}/media/${encodeURIComponent(pk)}/info/`,
      {
        headers: getInstagramApiHeaders(tabUrl)
      }
    );

    const media = Array.isArray(infoData?.items) ? infoData.items[0] : null;
    if (media) {
      return buildPostPlan(media, descriptor, "instagram_api_media_info");
    }
  } catch (err) {
    if (isRateLimitError(err)) {
      throw err;
    }

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
    if (isRateLimitError(err)) {
      throw err;
    }

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

export async function fetchPostComments(postPk, tabUrl) {
  if (!postPk) {
    return [];
  }

  const commentsUrl = new URL(`${INSTAGRAM_WEB_API_BASE_URL}/media/${encodeURIComponent(postPk)}/comments/`);
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
