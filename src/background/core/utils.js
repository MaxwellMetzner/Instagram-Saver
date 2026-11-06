export function sanitizeFilenamePart(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeUrl(url) {
  if (!url) return null;

  try {
    return new URL(url).href;
  } catch {
    return null;
  }
}

export function uniqBy(items, getKey) {
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

export function mergeShortcodeQueues(...queues) {
  const merged = [];
  const seen = new Set();

  for (const queue of queues) {
    for (const shortcode of queue || []) {
      if (!shortcode || seen.has(shortcode)) continue;
      seen.add(shortcode);
      merged.push(shortcode);
    }
  }

  return merged;
}

export function getJitteredDelayMs(range) {
  if (!Array.isArray(range) || range.length < 2) {
    return 0;
  }

  const minValue = Number(range[0] || 0);
  const maxValue = Number(range[1] || 0);
  const min = Math.max(0, Math.min(minValue, maxValue));
  const max = Math.max(0, Math.max(minValue, maxValue));
  if (max <= min) {
    return min;
  }

  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
