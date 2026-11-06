import { InstagramResolverError, toErrorDetails } from "../core/errors.js";
import { logWarn } from "../core/logger.js";
import { getMediaMatchKey } from "../instagram/media.js";
import { probeVisibleMedia } from "../instagram/page-data.js";

export const CURRENT_ITEM_KINDS = new Set(["post", "story", "highlight"]);

export function supportsCurrentItem(pageKind) {
  return CURRENT_ITEM_KINDS.has(pageKind);
}

function findIndexByMediaId(items, mediaPk) {
  if (!mediaPk) return -1;
  return items.findIndex((item) => String(item?.mediaId || "").split("_")[0] === String(mediaPk));
}

// Returns the index of the item whose file names appear in the largest visible media element.
export function matchVisibleMedia(items, visibleMedia) {
  const keyToIndex = new Map();
  items.forEach((item, index) => {
    for (const key of item?.matchKeys || []) {
      if (!keyToIndex.has(key)) keyToIndex.set(key, index);
    }
  });

  if (!keyToIndex.size) return -1;

  for (const element of visibleMedia || []) {
    for (const url of element?.urls || []) {
      const key = getMediaMatchKey(url);
      if (key && keyToIndex.has(key)) {
        return keyToIndex.get(key);
      }
    }
  }

  return -1;
}

/**
 * Works out which item of a post/story/highlight is on screen.
 * Returns { index, method } where method is "single", "url", "screen", or "assumed", or null when unknown.
 */
export async function locateCurrentItem(descriptor, items, tabId = null) {
  if (!Array.isArray(items) || !items.length || !supportsCurrentItem(descriptor?.kind)) {
    return null;
  }

  if (items.length === 1) {
    return { index: 0, method: "single" };
  }

  if (descriptor.kind === "story" || descriptor.kind === "highlight") {
    const urlIndex = findIndexByMediaId(items, descriptor.focusPk);
    if (urlIndex >= 0) {
      return { index: urlIndex, method: "url" };
    }
  }

  if (tabId) {
    try {
      const screenIndex = matchVisibleMedia(items, await probeVisibleMedia(tabId));
      if (screenIndex >= 0) {
        return { index: screenIndex, method: "screen" };
      }
    } catch (err) {
      logWarn("current_item_probe_failed", {
        kind: descriptor.kind,
        error: toErrorDetails(err)
      });
    }
  }

  if (descriptor.kind === "post") {
    const focusIndex = Number.isInteger(descriptor.focusIndex) ? descriptor.focusIndex : null;
    if (focusIndex !== null && focusIndex < items.length) {
      return { index: focusIndex, method: "url" };
    }

    // Instagram only adds ?img_index once you move through a carousel, so no hint means the first slide.
    return { index: 0, method: "assumed" };
  }

  return null;
}

export function selectCurrentItem(plan, location) {
  const item = plan.items[location.index];
  return {
    ...plan,
    items: [{ ...item, selectionIndex: location.index }],
    meta: {
      ...plan.meta,
      downloadScope: "current",
      currentItem: {
        position: location.index + 1,
        total: plan.items.length,
        method: location.method
      }
    }
  };
}

export function currentItemUnknownError(descriptor) {
  const noun = descriptor?.kind === "highlight" ? "highlight frame" : "story";
  return new InstagramResolverError(
    "current_item_unknown",
    `Couldn't tell which ${noun} is on screen right now.`,
    { kind: descriptor?.kind || null }
  );
}
