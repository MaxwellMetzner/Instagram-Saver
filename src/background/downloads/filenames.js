import { sanitizeFilenamePart } from "../core/utils.js";
import { buildDownloadKey } from "../storage/history.js";

function applyTemplate(template, context, fallback) {
  const rendered = String(template || fallback || "")
    .replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key) => sanitizeFilenamePart(context[key] ?? ""))
    .replace(/_+/g, "_")
    .replace(/\/+/g, "/")
    .trim();

  return rendered || fallback;
}

function guessExtension(url, mediaType) {
  try {
    const parsed = new URL(url);
    const stp = (parsed.searchParams.get("stp") || "").toLowerCase();

    if (stp.includes("dst-jpg")) return "jpg";
    if (stp.includes("dst-webp")) return "webp";
    if (stp.includes("dst-png")) return "png";

    const fileName = parsed.pathname.split("/").pop() || "";
    const extensionMatch = fileName.match(/\.([a-z0-9]+)$/i);
    if (extensionMatch) {
      return extensionMatch[1].toLowerCase();
    }
  } catch {
    // ignore URL parsing issues
  }

  return mediaType === "video" ? "mp4" : "jpg";
}

function buildTemplateContext(meta, item, itemIndex) {
  const timestamp = item?.timestamp || meta?.timestamp;
  const date = timestamp ? new Date(timestamp * 1000).toISOString().slice(0, 10) : "unknown-date";

  return {
    username: meta?.username || "instagram",
    id: item?.postId || meta?.id || item?.mediaId || "media",
    index: String(itemIndex + 1).padStart(2, "0"),
    kind: meta?.pageKind || "media",
    type: item?.type || "media",
    date
  };
}

function trimSlashes(value) {
  return String(value || "").replace(/^\/+|\/+$/g, "");
}

function splitRelativePath(relativePath) {
  const cleanPath = trimSlashes(relativePath);
  const lastSlashIndex = cleanPath.lastIndexOf("/");
  const directory = lastSlashIndex >= 0 ? cleanPath.slice(0, lastSlashIndex) : "";
  const fileName = lastSlashIndex >= 0 ? cleanPath.slice(lastSlashIndex + 1) : cleanPath;
  const extensionIndex = fileName.lastIndexOf(".");

  return {
    directory,
    baseName: extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName,
    extension: extensionIndex > 0 ? fileName.slice(extensionIndex) : ""
  };
}

function joinRelativePath(directory, fileName) {
  return directory ? `${trimSlashes(directory)}/${fileName}` : fileName;
}

export function ensureUniqueRelativePath(relativePath, uniqueHint, usedPaths) {
  const pathInfo = splitRelativePath(relativePath);
  const cleanHint = sanitizeFilenamePart(uniqueHint || "").replace(/\s+/g, "_") || "unique";
  let candidate = joinRelativePath(pathInfo.directory, `${pathInfo.baseName}${pathInfo.extension}`);

  if (!usedPaths.has(candidate)) {
    usedPaths.add(candidate);
    return candidate;
  }

  candidate = joinRelativePath(pathInfo.directory, `${pathInfo.baseName}__${cleanHint}${pathInfo.extension}`);
  if (!usedPaths.has(candidate)) {
    usedPaths.add(candidate);
    return candidate;
  }

  let counter = 2;
  while (usedPaths.has(candidate)) {
    candidate = joinRelativePath(pathInfo.directory, `${pathInfo.baseName}__${cleanHint}_${counter}${pathInfo.extension}`);
    counter += 1;
  }

  usedPaths.add(candidate);
  return candidate;
}

export function buildMediaFilename(item, meta, itemIndex, settings) {
  const context = buildTemplateContext(meta, item, itemIndex);
  const baseFolder = trimSlashes(applyTemplate(settings.folderTemplate, context, "instagram"));
  const baseName = applyTemplate(settings.filenameTemplate, context, `${context.username}_${context.id}_${context.index}`);
  const extension = guessExtension(item.url, item.type);
  const fileName = `${sanitizeFilenamePart(baseName)}.${extension}`;

  return baseFolder ? `${baseFolder}/${fileName}` : fileName;
}

export function buildMetadataFilename(meta, settings) {
  const context = buildTemplateContext(meta, null, 0);
  const baseFolder = trimSlashes(applyTemplate(settings.folderTemplate, context, "instagram"));
  const baseName = applyTemplate(
    settings.metadataFilenameTemplate,
    context,
    `${context.username}_${context.id}_metadata`
  );
  const fileName = `${sanitizeFilenamePart(baseName)}.json`;

  if (settings.placeMetadataInSubfolder) {
    const metadataFolder = baseFolder ? `${baseFolder}/_metadata` : "_metadata";
    return `${metadataFolder}/${fileName}`;
  }

  return baseFolder ? `${baseFolder}/${fileName}` : fileName;
}

export function buildBatchReportFilename(meta, settings) {
  const context = buildTemplateContext(meta, null, 0);
  const baseFolder = trimSlashes(applyTemplate(settings.folderTemplate, context, "instagram"));
  const fileName = `${sanitizeFilenamePart(`${context.username}_${context.id}_report`)}.json`;
  const reportFolder = baseFolder ? `${baseFolder}/_reports` : "_reports";
  return `${reportFolder}/${fileName}`;
}

export function buildPlannedEntries(plan, settings, knownDownloadKeys = new Set()) {
  const usedPaths = new Set();

  return plan.items.map((item, itemIndex) => {
    // A "current item only" download keeps the item's original position so {index} matches a full download.
    const position = Number.isInteger(item.selectionIndex) ? item.selectionIndex : itemIndex;
    const desiredFilename = buildMediaFilename(item, plan.meta, position, settings);
    const uniqueHint = item.mediaId || item.postId || `${item.type}_${position + 1}`;
    const filename = ensureUniqueRelativePath(desiredFilename, uniqueHint, usedPaths);

    return {
      item,
      index: itemIndex,
      filename,
      downloadKey: buildDownloadKey(item),
      alreadyDownloaded: knownDownloadKeys.has(buildDownloadKey(item))
    };
  });
}
