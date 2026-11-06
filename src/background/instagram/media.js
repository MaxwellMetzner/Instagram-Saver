import { normalizeUrl } from "../core/utils.js";

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

export function getCaptionText(media) {
  return (
    media?.caption?.text ||
    media?.edge_media_to_caption?.edges?.[0]?.node?.text ||
    media?.accessibility_caption ||
    null
  );
}

export function extractOwner(media) {
  return {
    username: media?.user?.username || media?.owner?.username || "instagram",
    fullName: media?.user?.full_name || media?.owner?.full_name || "",
    ownerId: String(media?.user?.pk || media?.user?.id || media?.owner?.id || media?.owner?.pk || "") || null
  };
}

export function getCarouselChildren(media) {
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

export function getMediaMatchKey(url) {
  if (!url || typeof url !== "string") return null;
  try {
    const fileName = new URL(url, "https://www.instagram.com/").pathname.split("/").pop() || "";
    return fileName.length >= 6 ? fileName.toLowerCase() : null;
  } catch {
    return null;
  }
}

// File names shared by every resolution of a media item; used to recognise it in the page DOM.
function collectMatchKeys(media, primaryUrl) {
  const urls = [
    primaryUrl,
    media?.display_url,
    media?.video_url,
    ...(media?.image_versions2?.candidates || []).map((candidate) => candidate?.url),
    ...(media?.video_versions || []).map((version) => version?.url),
    ...(media?.display_resources || []).map((resource) => resource?.src)
  ];

  return Array.from(new Set(urls.map(getMediaMatchKey).filter(Boolean))).slice(0, 16);
}

export function normalizePostEntry(media, meta, index) {
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
    timestamp: Number(media?.taken_at || media?.taken_at_timestamp || meta.timestamp || 0) || null,
    matchKeys: collectMatchKeys(media, url)
  };
}

export function hasCompleteStoryItems(reel) {
  const count = Array.isArray(reel?.items) ? reel.items.length : 0;
  return count > 0 &&
    count >= Number(reel.media_count || reel.item_count || 0) &&
    !reel.has_more && !reel.has_more_items && !reel.page_info?.has_next_page;
}

export function normalizeStoryEntry(item, meta, index) {
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
    expiresAt: Number(item?.expiring_at || 0) || null,
    matchKeys: collectMatchKeys(item, url)
  };
}
