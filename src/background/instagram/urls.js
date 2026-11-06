const INSTAGRAM_SHORTCODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function isInstagramUrl(url) {
  try {
    const host = new URL(url || "").hostname.toLowerCase();
    return host === "instagram.com" || host.endsWith(".instagram.com");
  } catch {
    return false;
  }
}

export function extractShortcodeFromUrl(url) {
  const match = String(url || "").match(/\/(?:p|reel|reels|tv)\/([^/?#&]+)/i);
  return match?.[1] || null;
}

export function instagramShortcodeToPk(shortcode) {
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

function parsePositiveInteger(value) {
  const numeric = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

// Instagram's share links carry the visible story frame as "<mediaPk>_<ownerId>".
function parseStoryMediaIdParam(searchParams) {
  const raw = searchParams.get("story_media_id") || "";
  const pk = raw.split("_")[0];
  return /^\d+$/.test(pk) ? pk : null;
}

export function getCanonicalPageUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(url || "");
  }
}

export function parseInstagramUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: "unsupported" };
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length >= 2 && ["p", "reel", "reels", "tv"].includes(parts[0])) {
    // Instagram deep-links carousel slides with a 1-based ?img_index=N.
    const imgIndex = parsePositiveInteger(parsed.searchParams.get("img_index"));
    return {
      kind: "post",
      subtype: parts[0] === "p" ? "post" : parts[0],
      shortcode: parts[1],
      focusIndex: imgIndex ? imgIndex - 1 : null
    };
  }

  if (parts[0] === "stories" && parts[1] === "highlights" && parts[2]) {
    return {
      kind: "highlight",
      highlightId: parts[2],
      focusPk: (parts[3] && /^\d+$/.test(parts[3]) ? parts[3] : null) || parseStoryMediaIdParam(parsed.searchParams)
    };
  }

  if (parts[0] === "stories" && parts[1]) {
    const storyPk = parts[2] || null;
    return {
      kind: "story",
      username: parts[1],
      storyPk,
      focusPk: storyPk || parseStoryMediaIdParam(parsed.searchParams)
    };
  }

  if (parts.length >= 3 && parts[1] === "saved") {
    if (parts[2] === "all-posts") {
      return {
        kind: "saved",
        username: parts[0],
        collectionId: null
      };
    }

    if (parts[3] && /^\d+$/.test(parts[3])) {
      return {
        kind: "saved",
        username: parts[0],
        collectionId: parts[3],
        collectionName: parts[2]
          .split("-")
          .filter(Boolean)
          .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
          .join(" ")
      };
    }
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

export function getProfilePageFetchUrl(tabUrl, username) {
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
