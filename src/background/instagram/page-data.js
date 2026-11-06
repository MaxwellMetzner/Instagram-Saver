import { sleep } from "../core/utils.js";
import { hasCompleteStoryItems } from "./media.js";

export async function extractInstagramPageData(tabId, username, shortcodeLimit = 48, highlightId = null) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [
      String(username || "").toLowerCase(),
      Math.max(1, Number(shortcodeLimit) || 48),
      highlightId
    ],
    func: (targetUsername, resultLimit, targetHighlightId) => {
      const requestedHighlightId = typeof targetHighlightId === "undefined"
        ? null
        : targetHighlightId;
      const roots = [
        window._sharedData,
        window.__initialData,
        window.__additionalData,
        window.__NEXT_DATA__
      ].filter((value) => value && typeof value === "object");

      function parseJsonCandidate(text) {
        const normalized = String(text || "").trim();
        if (!normalized || !/^[\[{]/.test(normalized)) return null;
        try {
          return JSON.parse(normalized);
        } catch {
          return null;
        }
      }

      function parseAssignedJson(text, marker) {
        const markerIndex = text.indexOf(marker);
        if (markerIndex < 0) return null;
        const start = text.indexOf("{", markerIndex + marker.length);
        if (start < 0) return null;

        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let index = start; index < text.length; index += 1) {
          const character = text[index];
          if (inString) {
            if (escaped) {
              escaped = false;
            } else if (character === "\\") {
              escaped = true;
            } else if (character === "\"") {
              inString = false;
            }
            continue;
          }
          if (character === "\"") {
            inString = true;
          } else if (character === "{") {
            depth += 1;
          } else if (character === "}" && --depth === 0) {
            return parseJsonCandidate(text.slice(start, index + 1));
          }
        }
        return null;
      }

      for (const script of Array.from(document.scripts)) {
        const text = script.textContent || "";
        if (!text || text.length > 5000000) continue;
        const parsed = parseJsonCandidate(text);
        if (parsed) roots.push(parsed);
        for (const marker of ["_sharedData", "\"user\""]) {
          if (text.includes(marker)) {
            const assignedData = parseAssignedJson(text, marker);
            if (assignedData) roots.push(assignedData);
          }
        }
      }

      // Story navigation may have no embedded owner data. Read only the rendered owner's identity.
      if (targetUsername && new URL(location.href).pathname.startsWith("/stories/")) {
        const seenFibers = new Set();
        let matchingLinks = 0;
        for (const anchor of document.querySelectorAll("a[href]")) {
          let pathname;
          try {
            pathname = new URL(anchor.href, location.href).pathname.toLowerCase();
          } catch {
            continue;
          }
          if (pathname !== `/${targetUsername}/`) continue;
          if (++matchingLinks > 10) break;
          const fiberKey = Object.keys(anchor).find((key) => key.startsWith("__reactFiber$"));
          let fiber = fiberKey ? anchor[fiberKey] : null;
          for (let depth = 0; fiber && depth < 100 && !seenFibers.has(fiber); depth += 1, fiber = fiber.return) {
            seenFibers.add(fiber);
            const props = fiber.memoizedProps;
            const username = String(props?.username || props?.user?.username || "").toLowerCase();
            const id = String(props?.userID || props?.userId || props?.user?.pk || props?.user?.id || "");
            if (username === targetUsername && /^\d+$/.test(id)) {
              roots.unshift({ id, pk: id, username });
              break;
            }
          }
        }
      }

      const visited = new Set();
      const matchingUsers = [];
      const timelineMatches = [];
      const matchingStoryReels = [];
      let visitedCount = 0;

      function visit(value, path, depth, highlightContextId = null) {
        if (!value || typeof value !== "object" || depth > 30 || visited.has(value) || visitedCount >= 100000) {
          return;
        }
        visited.add(value);
        visitedCount += 1;

        if (Array.isArray(value)) {
          for (let index = 0; index < value.length; index += 1) {
            visit(value[index], `${path}[${index}]`, depth + 1, highlightContextId);
          }
          return;
        }

        const valueUsername = String(value.username || "").toLowerCase();
        if (targetUsername && valueUsername === targetUsername && (value.id || value.pk)) {
          matchingUsers.push({
            id: String(value.id || value.pk),
            pk: String(value.pk || value.id),
            username: value.username,
            full_name: value.full_name || ""
          });
        }

        const storyOwner = value.user || value.owner;
        const storyItems = Array.isArray(value.items) ? value.items : [];
        const highlightId = String(value.id || value.pk || value.reel_id || "");
        const storyOwnerMatches = !requestedHighlightId && targetUsername &&
          !highlightId.startsWith("highlight:") && value.reel_type !== "highlight_reel" &&
          String(storyOwner?.username || "").toLowerCase() === targetUsername;
        const currentHighlightMatches = requestedHighlightId &&
          (highlightId === String(requestedHighlightId) ||
            highlightId === `highlight:${requestedHighlightId}`);
        const highlightMatches = currentHighlightMatches || highlightContextId;
        const isReelContainer = value.reel_type ||
          /reels_media|(?:^|\.)reels?(?:\.|$)/.test(path) ||
          highlightId && highlightId === String(storyOwner?.id || storyOwner?.pk || "") ||
          currentHighlightMatches;
        if (
          isReelContainer &&
          (storyOwnerMatches || highlightMatches) &&
          (storyOwner?.id || storyOwner?.pk || highlightMatches) &&
          storyItems.some((item) => item?.pk || item?.id)
        ) {
          matchingStoryReels.push({
            reel: value,
            score: storyItems.filter((item) => item?.pk || item?.id).length
          });
        }

        const routeUsername = String(value.params?.username || "").toLowerCase();
        const routeProfileId = routeUsername === targetUsername
          ? value.route?.rootView?.props?.id ||
            value.route?.rootView?.props?.page_logging?.params?.profile_id ||
            value.route?.profile_id ||
            null
          : null;
        if (targetUsername && routeProfileId) {
          matchingUsers.push({
            id: String(routeProfileId),
            pk: String(routeProfileId),
            username: targetUsername,
            full_name: ""
          });
        }

        const edges = Array.isArray(value.edges) ? value.edges : [];
        const shortcodes = edges
          .map((edge) => edge?.node?.shortcode || edge?.node?.code)
          .filter((shortcode) => typeof shortcode === "string" && shortcode);
        if (shortcodes.length || value.page_info?.end_cursor) {
          const edgeOwnersMatch = edges.some((edge) => {
            const owner = edge?.node?.owner || edge?.node?.user;
            return String(owner?.username || "").toLowerCase() === targetUsername;
          });
          const pathLooksLikeTimeline = /timeline|media|profile|user/i.test(path);
          if (edgeOwnersMatch || pathLooksLikeTimeline) {
            timelineMatches.push({
              shortcodes,
              nextCursor: value.page_info?.end_cursor || null,
              hasNextPage: Boolean(value.page_info?.has_next_page),
              score: shortcodes.length * 10 + (edgeOwnersMatch ? 5 : 0) + (pathLooksLikeTimeline ? 2 : 0)
            });
          }
        }

        const nextHighlightContextId = currentHighlightMatches
          ? String(requestedHighlightId)
          : highlightContextId;
        for (const [key, nestedValue] of Object.entries(value)) {
          visit(nestedValue, path ? `${path}.${key}` : key, depth + 1, nextHighlightContextId);
        }
      }

      roots.forEach((root, index) => visit(root, `root${index}`, 0));

      const profileShortcodes = [];
      for (const anchor of document.querySelectorAll("a[href]")) {
        let pathSegments;
        try {
          pathSegments = new URL(anchor.href, location.href).pathname.split("/").filter(Boolean);
        } catch {
          continue;
        }
        const mediaPathIndex = ["p", "reel", "reels", "tv"].includes(pathSegments[0])
          ? 0
          : ["p", "reel", "reels", "tv"].includes(pathSegments[1])
            ? 1
            : -1;
        const shortcode = mediaPathIndex >= 0
          ? pathSegments[mediaPathIndex + 1]
          : null;
        if (shortcode && /^[A-Za-z0-9_-]+$/.test(shortcode) && !profileShortcodes.includes(shortcode)) {
          profileShortcodes.push(shortcode);
          if (profileShortcodes.length >= resultLimit) break;
        }
      }

      matchingUsers.sort((left, right) => Number(Boolean(right.full_name)) - Number(Boolean(left.full_name)));
      timelineMatches.sort((left, right) => right.score - left.score);
      matchingStoryReels.sort((left, right) => right.score - left.score);
      const matchedUser = matchingUsers[0] || null;
      const matchedTimeline = timelineMatches[0] || null;
      const matchedStoryReel = matchingStoryReels[0]?.reel || null;
      const shortcodes = matchedTimeline?.shortcodes?.length
        ? matchedTimeline.shortcodes
        : profileShortcodes;

      if (!matchedUser && !shortcodes.length && !matchedStoryReel) return null;
      return {
        user: matchedUser || (matchedStoryReel
          ? {
            id: String(matchedStoryReel.user?.id || matchedStoryReel.user?.pk || ""),
            pk: String(matchedStoryReel.user?.pk || matchedStoryReel.user?.id || ""),
            username: matchedStoryReel.user?.username || targetUsername,
            full_name: matchedStoryReel.user?.full_name || ""
          }
          : { username: targetUsername }),
        storyReel: matchedStoryReel,
        timeline: {
          shortcodes: Array.from(new Set(shortcodes)).slice(0, resultLimit),
          nextCursor: matchedTimeline?.nextCursor || null,
          hasNextPage: Boolean(matchedTimeline?.hasNextPage)
        },
        source: matchedTimeline?.shortcodes?.length ? "profile_page_data" : "profile_page_links"
      };
    }
  });

  return results[0]?.result || null;
}

export async function extractStoryPageData(tabId, username, highlightId = null) {
  let pageData = null;
  const attempts = 8;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const nextData = await extractInstagramPageData(tabId, username, 1, highlightId);
    if (nextData) {
      pageData = {
        ...nextData,
        user: nextData.user?.id || nextData.user?.pk ? nextData.user : pageData?.user || nextData.user,
        storyReel: nextData.storyReel || pageData?.storyReel || null
      };
    }
    if (hasCompleteStoryItems(pageData?.storyReel)) {
      return pageData;
    }

    if (attempt < attempts - 1) {
      await sleep(250);
    }
  }

  return pageData;
}

// Lists the media elements currently visible in the tab, largest first, with every URL each one uses.
export async function probeVisibleMedia(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const minimumArea = 4000;
      const dialogs = Array.from(document.querySelectorAll("[role='dialog']"));
      const scope = dialogs.length ? dialogs[dialogs.length - 1] : document;

      function visibleArea(element) {
        const rect = element.getBoundingClientRect();
        let left = Math.max(rect.left, 0);
        let top = Math.max(rect.top, 0);
        let right = Math.min(rect.right, viewportWidth);
        let bottom = Math.min(rect.bottom, viewportHeight);

        // Carousels pre-render neighbouring slides off to the side; clip to overflow-hidden ancestors.
        let node = element.parentElement;
        while (node && node !== document.documentElement && right > left && bottom > top) {
          const style = getComputedStyle(node);
          if (style.overflowX !== "visible" || style.overflowY !== "visible") {
            const bounds = node.getBoundingClientRect();
            if (style.overflowX !== "visible") {
              left = Math.max(left, bounds.left);
              right = Math.min(right, bounds.right);
            }
            if (style.overflowY !== "visible") {
              top = Math.max(top, bounds.top);
              bottom = Math.min(bottom, bounds.bottom);
            }
          }
          node = node.parentElement;
        }

        return Math.max(0, right - left) * Math.max(0, bottom - top);
      }

      function isHidden(element) {
        const style = getComputedStyle(element);
        return style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0;
      }

      const found = [];
      for (const element of scope.querySelectorAll("img, video")) {
        if (isHidden(element)) continue;
        const area = visibleArea(element);
        if (area < minimumArea) continue;

        const urls = new Set();
        const add = (value) => {
          if (typeof value === "string" && /^https?:/i.test(value)) urls.add(value);
        };
        add(element.currentSrc);
        add(element.src);
        add(element.getAttribute("poster"));
        for (const part of String(element.getAttribute("srcset") || "").split(",")) {
          add(part.trim().split(/\s+/)[0]);
        }
        for (const source of element.querySelectorAll("source")) {
          add(source.src);
        }
        if (element.tagName === "VIDEO") {
          for (const image of element.parentElement?.querySelectorAll("img") || []) {
            add(image.currentSrc || image.src);
          }
        }

        if (urls.size) {
          found.push({ tag: element.tagName.toLowerCase(), area: Math.round(area), urls: Array.from(urls).slice(0, 16) });
        }
      }

      found.sort((left, right) => right.area - left.area);
      return found.slice(0, 24);
    }
  });

  return Array.isArray(results?.[0]?.result) ? results[0].result : [];
}
