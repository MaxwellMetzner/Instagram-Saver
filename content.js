let lastContextImage = null;
let lastContextVideo = null;
let statusToastEl = null;
let statusToastTimer = null;

document.addEventListener(
  "contextmenu",
  (e) => {
    const target = e.target;
    const img =
      target instanceof HTMLImageElement
        ? target
        : target?.closest?.("img") || null;
    const video =
      target instanceof HTMLVideoElement
        ? target
        : target?.closest?.("video") || null;

    if (img instanceof HTMLImageElement) {
      lastContextImage = img;
    }

    if (video instanceof HTMLVideoElement) {
      lastContextVideo = video;
    }
  },
  true
);

function decodeHtmlEntities(str) {
  if (!str) return str;
  // Handles &amp; -> &
  const textarea = document.createElement("textarea");
  textarea.innerHTML = str;
  return textarea.value;
}

function normalizeUrl(raw) {
  if (!raw) return null;
  try {
    const decoded = decodeHtmlEntities(raw.trim());
    return new URL(decoded, location.href).href;
  } catch {
    return null;
  }
}

function parseSrcset(srcset) {
  if (!srcset) return [];

  return srcset
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      // Typical forms:
      // <url> 1080w
      // <url> 2x
      const mW = part.match(/^(\S+)\s+(\d+)w$/i);
      if (mW) {
        return {
          url: normalizeUrl(mW[1]),
          type: "w",
          value: Number(mW[2])
        };
      }

      const mX = part.match(/^(\S+)\s+([\d.]+)x$/i);
      if (mX) {
        return {
          url: normalizeUrl(mX[1]),
          type: "x",
          value: Number(mX[2])
        };
      }

      // Bare URL fallback
      return {
        url: normalizeUrl(part),
        type: "unknown",
        value: 0
      };
    })
    .filter((c) => !!c.url);
}

function uniqUrls(urls) {
  const seen = new Set();
  const result = [];
  for (const raw of urls) {
    const url = normalizeUrl(raw);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    result.push(url);
  }
  return result;
}

function chooseBestFromSrcset(srcset) {
  const candidates = parseSrcset(srcset);

  const widthCandidates = candidates.filter((c) => c.type === "w");
  if (widthCandidates.length) {
    widthCandidates.sort((a, b) => b.value - a.value);
    return widthCandidates[0].url;
  }

  const densityCandidates = candidates.filter((c) => c.type === "x");
  if (densityCandidates.length) {
    densityCandidates.sort((a, b) => b.value - a.value);
    return densityCandidates[0].url;
  }

  return candidates[0]?.url || null;
}

function chooseBestImageUrl(img, fallbackSrcUrl) {
  if (!(img instanceof HTMLImageElement)) {
    return fallbackSrcUrl ? normalizeUrl(fallbackSrcUrl) : null;
  }

  const srcsetUrl = chooseBestFromSrcset(img.getAttribute("srcset") || img.srcset || "");
  if (srcsetUrl) return srcsetUrl;

  return (
    normalizeUrl(img.getAttribute("src")) ||
    normalizeUrl(img.currentSrc) ||
    normalizeUrl(img.src) ||
    normalizeUrl(fallbackSrcUrl) ||
    null
  );
}

function chooseBestVideoUrl(video, fallbackSrcUrl) {
  if (!(video instanceof HTMLVideoElement)) {
    return fallbackSrcUrl ? normalizeUrl(fallbackSrcUrl) : null;
  }

  const sourceUrls = Array.from(video.querySelectorAll("source"))
    .map((source) => source.getAttribute("src"))
    .filter(Boolean);

  return (
    normalizeUrl(video.currentSrc) ||
    normalizeUrl(video.src) ||
    uniqUrls(sourceUrls)[0] ||
    normalizeUrl(fallbackSrcUrl) ||
    null
  );
}

function isBlobUrl(url) {
  return String(url || "").startsWith("blob:");
}

function videoUrlScore(url) {
  if (!url) return -1000;
  if (isBlobUrl(url)) return -900;

  let score = 0;
  const lower = url.toLowerCase();

  if (isLikelyInstagramCdnUrl(url)) score += 80;
  if (isLikelyVideoUrl(url)) score += 50;
  if (/(\.mp4|\.webm|\.mov|\.m4v)(\?|$)/.test(lower)) score += 25;
  if (/\/v\/t16\//i.test(lower) || /-16\//i.test(lower)) score += 18;
  if (isLikelyVideoChunkUrl(lower)) score -= 80;
  if (isLikelyImageFileUrl(lower)) score -= 90;

  return score;
}

function pickBestVideoUrl(candidates) {
  const urls = uniqUrls(candidates).filter(Boolean);
  if (!urls.length) return null;

  const scored = urls
    .map((url) => ({ url, score: videoUrlScore(url) }))
    .sort((a, b) => b.score - a.score);

  const best = scored.find((entry) => entry.score > 0);
  return best?.url || scored[0]?.url || null;
}

function getBackgroundHintVideoUrls(backgroundHints) {
  const hinted = Array.isArray(backgroundHints?.videos) ? backgroundHints.videos : [];
  return uniqUrls(hinted)
    .filter((url) => isLikelyInstagramCdnUrl(url))
    .filter((url) => !isLikelyVideoChunkUrl(url))
    .filter((url) => !isBlobUrl(url));
}

function getMetaVideoUrls() {
  const selectors = [
    "meta[property='og:video']",
    "meta[property='og:video:url']",
    "meta[property='og:video:secure_url']",
    "meta[name='twitter:player:stream']"
  ];

  const urls = [];
  for (const selector of selectors) {
    const nodes = Array.from(document.querySelectorAll(selector));
    for (const node of nodes) {
      const value = node.getAttribute("content");
      const normalized = normalizeUrl(value);
      if (normalized) urls.push(normalized);
    }
  }

  return uniqUrls(urls)
    .filter((url) => isLikelyInstagramCdnUrl(url))
    .filter((url) => !isLikelyVideoChunkUrl(url));
}

function collectUrlsFromJsonValue(value, outUrls) {
  if (!value) return;

  if (typeof value === "string") {
    const normalized = normalizeUrl(value);
    if (normalized && isLikelyInstagramCdnUrl(normalized)) {
      outUrls.push(normalized);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectUrlsFromJsonValue(item, outUrls);
    }
    return;
  }

  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (/contenturl|embedurl|url|video/i.test(key)) {
        collectUrlsFromJsonValue(child, outUrls);
      } else if (typeof child === "object") {
        collectUrlsFromJsonValue(child, outUrls);
      }
    }
  }
}

function getJsonLdVideoUrls() {
  const scripts = Array.from(document.querySelectorAll("script[type='application/ld+json']"));
  const urls = [];

  for (const script of scripts) {
    const text = script.textContent || "";
    if (!text) continue;

    try {
      const parsed = JSON.parse(text);
      collectUrlsFromJsonValue(parsed, urls);
    } catch {
      // ignore malformed JSON-LD blobs
    }
  }

  return uniqUrls(urls)
    .filter((url) => isLikelyVideoUrl(url))
    .filter((url) => !isLikelyVideoChunkUrl(url));
}

function resolveBestVideoUrl(video, fallbackSrcUrl, backgroundHints) {
  const postRoot = getLikelyPostRoot();
  const direct = chooseBestVideoUrl(video, fallbackSrcUrl);
  const scriptOnlyVideos = getScriptVideoUrlsOnly();
  const scriptMedia = getScriptMediaUrls();
  const domPostVideos = collectPostVideoUrls(postRoot);
  const recentResourceVideos = getRecentVideoResourceUrls();
  const metaVideos = getMetaVideoUrls();
  const jsonLdVideos = getJsonLdVideoUrls();
  const hintedVideos = getBackgroundHintVideoUrls(backgroundHints);

  const candidates = uniqUrls([
    direct,
    ...hintedVideos,
    ...scriptOnlyVideos,
    ...scriptMedia.videos,
    ...domPostVideos,
    ...metaVideos,
    ...jsonLdVideos,
    ...recentResourceVideos
  ]).filter((url) => !isBlobUrl(url));

  return pickBestVideoUrl(candidates);
}

function getRecentVideoResourceUrls(limit = 16) {
  if (!performance?.getEntriesByType) return [];

  const entries = performance.getEntriesByType("resource");
  const urls = entries
    .map((entry) => entry?.name)
    .filter(Boolean)
    .filter((url) => /(cdninstagram\.com|fbcdn\.net)/i.test(url))
    .filter((url) => {
      const lower = url.toLowerCase();
      if (isLikelyVideoChunkUrl(lower)) return false;
      return (
        /(\.mp4|\.webm|\.mov|\.m4v)(\?|$)/.test(lower) ||
        /\/v\/t16\//i.test(lower) ||
        /-16\//i.test(lower) ||
        /mime_type=video/i.test(lower)
      );
    });

  return uniqUrls(urls.slice(-limit).reverse());
}

function extractUsername() {
  const pathMatch = location.pathname.match(/^\/([a-zA-Z0-9._]+)\/?$/);
  if (pathMatch?.[1] && !["p", "reel", "stories", "explore"].includes(pathMatch[1])) {
    return pathMatch[1];
  }

  const profileLink = document.querySelector("header a[href^='/' i]");
  if (profileLink instanceof HTMLAnchorElement) {
    const match = profileLink.getAttribute("href")?.match(/^\/([a-zA-Z0-9._]+)\/?/);
    if (match?.[1]) return match[1];
  }

  return "instagram";
}

function extractShortcode() {
  const match = location.pathname.match(/\/(?:p|reel)\/([^/?#]+)/i);
  if (match?.[1]) return match[1];
  return "post";
}

function getLikelyPostRoot() {
  const article = document.querySelector("article");
  if (article) return article;
  return document.body;
}

function isLikelyInstagramCdnUrl(url) {
  if (!url) return false;
  return /(cdninstagram\.com|fbcdn\.net)/i.test(url);
}

function isLikelyInstagramMediaUrl(url) {
  if (!url) return false;
  return isLikelyInstagramCdnUrl(url);
}

function isLikelyVideoUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();

  if (/\.(mp4|webm|mov|m4v)(\?|$)/.test(lower)) return true;
  if (/\/v\/t16\//i.test(lower)) return true;
  if (/-16\//i.test(lower)) return true;
  if (/\bvideo\b/i.test(lower)) return true;

  try {
    const params = new URL(url).searchParams;
    const mimeType = (params.get("mime_type") || "").toLowerCase();
    if (mimeType.startsWith("video/")) return true;
  } catch {
    // ignore
  }

  return false;
}

function isLikelyVideoChunkUrl(url) {
  if (!url) return true;
  const lower = url.toLowerCase();

  if (/\.m4s(\?|$)/.test(lower)) return true;
  if (/[?&](bytestart|byteend|range)=/i.test(lower)) return true;

  return false;
}

function isLikelyImageFileUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  return /\.(jpg|jpeg|png|webp|heic|gif)(\?|$)/.test(lower);
}

function isLikelyAvatarUrl(url) {
  if (!url) return true;

  const lower = url.toLowerCase();
  if (/\/t51\.2885-19\//i.test(lower)) return true;
  if (/\b(?:s|c)\d{2,3}x\d{2,3}\b/i.test(lower)) return true;

  try {
    const stp = (new URL(url).searchParams.get("stp") || "").toLowerCase();
    if (/s\d{2,3}x\d{2,3}/i.test(stp)) return true;
    if (stp.includes("c0.50")) return true;
  } catch {
    // ignore parse failures
  }

  return false;
}

function imageQualityScore(url) {
  if (!url) return -1;

  let score = 0;
  if (/cdninstagram\.com/i.test(url)) score += 100;
  if (/\/v\/t51\./i.test(url)) score += 100;

  try {
    const params = new URL(url).searchParams;
    const stp = (params.get("stp") || "").toLowerCase();

    if (stp.includes("dst-jpg")) score += 50;
    const sizeMatch = stp.match(/s(\d+)x(\d+)/i);
    if (sizeMatch) {
      score += Number(sizeMatch[1]) / 1000;
    } else {
      score += 10;
    }
  } catch {
    // ignore URL parse issues
  }

  return score;
}

function collectPostImageUrls(root) {
  const images = Array.from(root.querySelectorAll("img[src], img[srcset]"))
    .filter((img) => !img.closest("header, aside"));

  const urls = images
    .map((img) => chooseBestImageUrl(img, null))
    .filter((url) => isLikelyInstagramMediaUrl(url) && !isLikelyAvatarUrl(url));

  return uniqUrls(urls).sort((a, b) => imageQualityScore(b) - imageQualityScore(a));
}

function collectPostVideoUrls(root) {
  const videos = Array.from(root.querySelectorAll("video"));
  const urls = videos
    .map((video) => chooseBestVideoUrl(video, null))
    .filter((url) => isLikelyInstagramMediaUrl(url) && isLikelyVideoUrl(url));

  const hasBlobVideo = videos.some((video) => {
    const src = String(video.currentSrc || video.src || "");
    return src.startsWith("blob:");
  });

  if (hasBlobVideo) {
    urls.push(...getRecentVideoResourceUrls());
  }

  return uniqUrls(urls);
}

function decodeEmbeddedUrl(raw) {
  if (!raw) return null;
  const decoded = raw
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/")
    .replace(/\\u003D/g, "=")
    .replace(/\\u0025/g, "%");
  return normalizeUrl(decoded);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractUrlsByRegex(text, regex) {
  const urls = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    const url = decodeEmbeddedUrl(match[1]);
    if (url) urls.push(url);
  }
  return urls;
}

function getLargestCandidateFromImageVersions(imageVersions) {
  const candidates = imageVersions?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  const sorted = [...candidates].sort((a, b) => {
    const aw = Number(a?.width || 0);
    const bw = Number(b?.width || 0);
    return bw - aw;
  });

  return decodeEmbeddedUrl(sorted[0]?.url || null);
}

function getLargestDisplayResource(resources) {
  if (!Array.isArray(resources) || resources.length === 0) return null;

  const sorted = [...resources].sort((a, b) => {
    const aw = Number(a?.config_width || 0);
    const bw = Number(b?.config_width || 0);
    return bw - aw;
  });

  return decodeEmbeddedUrl(sorted[0]?.src || null);
}

function getBestVideoVersionUrl(videoVersions) {
  if (!Array.isArray(videoVersions) || videoVersions.length === 0) return null;

  const sorted = [...videoVersions].sort((a, b) => {
    const aPixels = Number(a?.width || 0) * Number(a?.height || 0);
    const bPixels = Number(b?.width || 0) * Number(b?.height || 0);
    return bPixels - aPixels;
  });

  for (const candidate of sorted) {
    const url = decodeEmbeddedUrl(candidate?.url || null);
    if (url && isLikelyVideoUrl(url)) return url;
  }

  return decodeEmbeddedUrl(sorted[0]?.url || null);
}

function collectMediaFromNode(node, imageUrls, videoUrls) {
  if (!node || typeof node !== "object") return;

  if (node.is_video) {
    const videoUrl =
      decodeEmbeddedUrl(node.video_url || null) ||
      getBestVideoVersionUrl(node.video_versions);
    if (videoUrl) videoUrls.push(videoUrl);
  }

  const imageUrl =
    decodeEmbeddedUrl(node.display_url || null) ||
    getLargestDisplayResource(node.display_resources) ||
    getLargestCandidateFromImageVersions(node.image_versions2);

  if (imageUrl) imageUrls.push(imageUrl);

  const edges = node?.edge_sidecar_to_children?.edges;
  if (Array.isArray(edges)) {
    for (const edge of edges) {
      collectMediaFromNode(edge?.node, imageUrls, videoUrls);
    }
  }
}

function findJsonObjectAfterKey(text, key) {
  const keyIndex = text.indexOf(key);
  if (keyIndex === -1) return null;

  const colonIndex = text.indexOf(":", keyIndex + key.length);
  if (colonIndex === -1) return null;

  let start = colonIndex + 1;
  while (start < text.length && /\s/.test(text[start])) start += 1;
  if (text[start] !== "{") return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

function tryParseShortcodeMediaFromScript(text) {
  const keys = ["\"xdt_shortcode_media\"", "\"shortcode_media\""];

  for (const key of keys) {
    const objectText = findJsonObjectAfterKey(text, key);
    if (!objectText) continue;

    try {
      const node = JSON.parse(objectText);
      const imageUrls = [];
      const videoUrls = [];
      collectMediaFromNode(node, imageUrls, videoUrls);

      if (imageUrls.length || videoUrls.length) {
        return {
          images: imageUrls,
          videos: videoUrls
        };
      }
    } catch {
      // fall through to regex extraction
    }
  }

  return null;
}

function getScriptMediaUrls() {
  const scripts = Array.from(document.querySelectorAll("script"));
  const imageUrls = [];
  const videoUrls = [];

  for (const script of scripts) {
    const text = script.textContent || "";
    if (
      !text ||
      !/instagram|xdt|shortcode|video_url|video_versions|progressive|playback_video_url|display_url|thumbnail_src/i.test(
        text
      )
    ) {
      continue;
    }

    const parsed = tryParseShortcodeMediaFromScript(text);
    if (parsed) {
      imageUrls.push(...parsed.images);
      videoUrls.push(...parsed.videos);
    }

    videoUrls.push(
      ...extractUrlsByRegex(text, /"video_url"\s*:\s*"([^"]+)"/g),
      ...extractUrlsByRegex(text, /"video_versions"\s*:\s*\[[\s\S]*?"url"\s*:\s*"([^"]+)"/g),
      ...extractUrlsByRegex(text, /"progressive_download_url"\s*:\s*"([^"]+)"/g),
      ...extractUrlsByRegex(text, /"progressive_url"\s*:\s*"([^"]+)"/g)
    );

    imageUrls.push(
      ...extractUrlsByRegex(text, /"display_url"\s*:\s*"([^"]+)"/g),
      ...extractUrlsByRegex(text, /"thumbnail_src"\s*:\s*"([^"]+)"/g),
      ...extractUrlsByRegex(text, /"display_resources"\s*:\s*\[[\s\S]*?"src"\s*:\s*"([^"]+)"/g)
    );
  }

  const filteredImages = uniqUrls(imageUrls)
    .filter((url) => isLikelyInstagramMediaUrl(url) && !isLikelyAvatarUrl(url))
    .sort((a, b) => imageQualityScore(b) - imageQualityScore(a));
  const filteredVideos = uniqUrls(videoUrls)
    .filter((url) => isLikelyInstagramMediaUrl(url))
    .filter((url) => !isLikelyVideoChunkUrl(url))
    .filter((url) => !isLikelyImageFileUrl(url) || isLikelyVideoUrl(url));

  return {
    images: filteredImages,
    videos: filteredVideos
  };
}

function getScriptVideoUrlsOnly() {
  const scripts = Array.from(document.querySelectorAll("script"));
  const urls = [];

  for (const script of scripts) {
    const text = script.textContent || "";
    if (!text) continue;

    urls.push(
      ...extractUrlsByRegex(text, /"video_url"\s*:\s*"([^"]+)"/g),
      ...extractUrlsByRegex(text, /"video_versions"\s*:\s*\[[\s\S]*?"url"\s*:\s*"([^"]+)"/g),
      ...extractUrlsByRegex(text, /"progressive_download_url"\s*:\s*"([^"]+)"/g),
      ...extractUrlsByRegex(text, /"progressive_url"\s*:\s*"([^"]+)"/g),
      ...extractUrlsByRegex(text, /"playback_video_url"\s*:\s*"([^"]+)"/g)
    );
  }

  return uniqUrls(urls)
    .filter((url) => isLikelyInstagramCdnUrl(url))
    .filter((url) => !isLikelyVideoChunkUrl(url))
    .filter((url) => !isLikelyImageFileUrl(url));
}

function isVisibleAndEnabled(button) {
  if (!(button instanceof HTMLButtonElement)) return false;
  if (button.disabled) return false;

  const style = window.getComputedStyle(button);
  if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) {
    return false;
  }

  const rect = button.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function findNavButton(root, direction) {
  const articleRoot = root || document;

  const primarySelectors =
    direction === "next"
      ? [
          "button[aria-label='Next']",
          "button[aria-label*='Next' i]",
          "button._afxw._al46._al47[aria-label='Next']",
          "button[aria-label='Next photo']",
          "button[aria-label='Next slide']",
          "button svg[aria-label='Next']"
        ]
      : [
          "button[aria-label='Previous']",
          "button[aria-label*='Previous' i]",
          "button._afxw._al46._al47[aria-label='Previous']",
          "button[aria-label='Previous photo']",
          "button[aria-label='Previous slide']",
          "button svg[aria-label='Go back']"
        ];

  for (const selector of primarySelectors) {
    const nodes = Array.from(articleRoot.querySelectorAll(selector));
    for (const node of nodes) {
      const button = node instanceof HTMLButtonElement ? node : node.closest("button");
      if (button && isVisibleAndEnabled(button)) {
        return button;
      }
    }
  }

  return null;
}

async function waitForSlideRender() {
  await sleep(420);
}

async function moveCarouselToStart(root, maxMoves = 15) {
  for (let i = 0; i < maxMoves; i += 1) {
    const prevButton = findNavButton(root, "prev");
    if (!prevButton) break;

    prevButton.click();
    await waitForSlideRender();
  }
}

async function traverseCarouselMedia(root, maxSteps = 20) {
  const collected = [];
  const seen = new Set();

  for (let step = 0; step < maxSteps; step += 1) {
    const current = uniqUrls([
      ...collectPostVideoUrls(root),
      ...collectPostImageUrls(root)
    ]);

    for (const url of current) {
      if (!seen.has(url)) {
        seen.add(url);
        collected.push(url);
      }
    }

    const nextButton = findNavButton(root, "next");
    if (!nextButton) break;

    nextButton.click();
    await waitForSlideRender();
  }

  return collected;
}

async function getPostMediaUrls(backgroundHints = null) {
  const root = getLikelyPostRoot();
  const scriptMedia = getScriptMediaUrls();
  const scriptOnlyVideos = getScriptVideoUrlsOnly();
  const domImageUrls = collectPostImageUrls(root);
  const domVideoUrls = collectPostVideoUrls(root);
  const metaVideoUrls = getMetaVideoUrls();
  const jsonLdVideoUrls = getJsonLdVideoUrls();
  const hintedVideoUrls = getBackgroundHintVideoUrls(backgroundHints);

  let traversed = [];
  const hasCarouselNav = !!findNavButton(root, "next") || !!findNavButton(root, "prev");
  if (hasCarouselNav) {
    await moveCarouselToStart(root);
    traversed = await traverseCarouselMedia(root);
  }

  const traversedVideos = traversed.filter((url) => isLikelyVideoUrl(url));
  const traversedImages = traversed.filter((url) => !isLikelyVideoUrl(url));

  const merged = uniqUrls([
    ...hintedVideoUrls,
    ...scriptOnlyVideos,
    ...scriptMedia.videos,
    ...metaVideoUrls,
    ...jsonLdVideoUrls,
    ...traversedVideos,
    ...domVideoUrls,
    ...scriptMedia.images,
    ...traversedImages,
    ...domImageUrls
  ]);

  if (merged.length) {
    return merged;
  }

  const fallbackImages = Array.from(root.querySelectorAll("img"))
    .map((img) => chooseBestImageUrl(img, null))
    .filter(Boolean);
  const fallbackVideos = Array.from(root.querySelectorAll("video"))
    .map((video) => chooseBestVideoUrl(video, null))
    .filter(Boolean);

  return uniqUrls([...fallbackVideos, ...fallbackImages]).filter((url) => !isLikelyAvatarUrl(url));
}

function getMeta() {
  return {
    username: extractUsername(),
    shortcode: extractShortcode()
  };
}

function showStatusToast(message, level = "info") {
  if (!message) return;

  if (!statusToastEl) {
    statusToastEl = document.createElement("div");
    statusToastEl.style.position = "fixed";
    statusToastEl.style.top = "16px";
    statusToastEl.style.right = "16px";
    statusToastEl.style.left = "auto";
    statusToastEl.style.bottom = "auto";
    statusToastEl.style.transform = "none";
    statusToastEl.style.padding = "10px 14px";
    statusToastEl.style.borderRadius = "10px";
    statusToastEl.style.color = "#fff";
    statusToastEl.style.fontFamily = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    statusToastEl.style.fontSize = "13px";
    statusToastEl.style.fontWeight = "600";
    statusToastEl.style.zIndex = "2147483647";
    statusToastEl.style.boxShadow = "0 8px 24px rgba(0,0,0,0.28)";
    statusToastEl.style.pointerEvents = "none";
    statusToastEl.style.opacity = "0";
    statusToastEl.style.transition = "opacity 120ms ease";
    document.documentElement.appendChild(statusToastEl);
  }

  const backgroundByLevel = {
    info: "rgba(30, 64, 175, 0.95)",
    success: "rgba(21, 128, 61, 0.95)",
    error: "rgba(185, 28, 28, 0.95)"
  };

  statusToastEl.textContent = message;
  statusToastEl.style.background = backgroundByLevel[level] || backgroundByLevel.info;
  statusToastEl.style.opacity = "1";

  if (statusToastTimer) {
    clearTimeout(statusToastTimer);
  }

  statusToastTimer = setTimeout(() => {
    if (statusToastEl) {
      statusToastEl.style.opacity = "0";
    }
  }, 2800);
}

function classifyMedia(url) {
  if (isLikelyVideoUrl(url)) return "video";
  return "image";
}

function buildConfirmMessage(urls, meta) {
  const safeUrls = Array.isArray(urls) ? urls.filter(Boolean) : [];
  const videoCount = safeUrls.filter((url) => classifyMedia(url) === "video").length;
  const imageCount = safeUrls.length - videoCount;
  const username = meta?.username ? `@${meta.username}` : "this post";

  const lines = [
    `Download ${safeUrls.length} file${safeUrls.length === 1 ? "" : "s"} from ${username}?`,
    "",
    `Images: ${imageCount}`,
    `Videos: ${videoCount}`
  ];

  return lines.join("\n");
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg?.type) return;

  try {
    if (msg.type === "PING") {
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === "SHOW_STATUS_TOAST") {
      showStatusToast(msg.message, msg.level);
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === "CONFIRM_DOWNLOAD") {
      const urls = Array.isArray(msg.urls) ? msg.urls : [];
      if (urls.length === 0) {
        sendResponse({ confirmed: false });
        return false;
      }

      const confirmed = window.confirm(buildConfirmMessage(urls, msg.meta || {}));
      sendResponse({ confirmed });
      return false;
    }

    if (msg.type === "GET_BEST_IMAGE_URL") {
      const bestUrl = chooseBestImageUrl(lastContextImage, msg.fallbackSrcUrl);
      sendResponse({
        ok: !!bestUrl,
        url: bestUrl,
        meta: getMeta()
      });
      return false;
    }

    if (msg.type === "GET_BEST_VIDEO_URL") {
      const bestUrl = resolveBestVideoUrl(lastContextVideo, msg.fallbackSrcUrl, msg.backgroundHints);
      sendResponse({
        ok: !!bestUrl,
        url: bestUrl,
        meta: getMeta()
      });
      return false;
    }

    if (msg.type === "GET_POST_MEDIA") {
      getPostMediaUrls(msg.backgroundHints)
        .then((urls) => {
          sendResponse({
            ok: urls.length > 0,
            urls,
            meta: getMeta(),
            error: urls.length ? null : "No media found in this post."
          });
        })
        .catch((err) => {
          sendResponse({
            ok: false,
            error: String(err)
          });
        });
      return true;
    }
  } catch (err) {
    sendResponse({
      ok: false,
      error: String(err)
    });
    return false;
  }

  return false;
});