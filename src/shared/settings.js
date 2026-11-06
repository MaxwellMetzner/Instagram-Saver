// Single source of truth for user settings, shared by the service worker, popup, and options page.

export const THEME_MODES = ["system", "light", "dark", "instagram"];
export const DOWNLOAD_SCOPES = ["all", "current"];
export const DUPLICATE_MODES = ["history", "none"];
export const MEDIA_FILTERS = ["all", "images", "videos"];
export const BULK_PACES = ["safer", "balanced", "aggressive"];

export const QUICK_DOWNLOAD_LIMIT_MIN = 1;
export const QUICK_DOWNLOAD_LIMIT_MAX = 200;

export const DEFAULT_SETTINGS = Object.freeze({
  themeMode: "light",
  easyMode: false,
  defaultDownloadScope: "all",
  confirmBeforeDownload: true,
  promptForSingleDownload: false,
  duplicateMode: "history",
  maxProfilePosts: 24,
  profileMediaFilter: "all",
  bulkPace: "aggressive",
  folderTemplate: "instagram/{username}",
  filenameTemplate: "{username}_{id}_{index}",
  saveMetadataSidecar: false,
  placeMetadataInSubfolder: false,
  exportPostComments: false,
  exportBatchReport: false,
  metadataFilenameTemplate: "{username}_{id}_metadata"
});

// Keys written by older versions; normalizeSettings migrates them and saving removes them.
export const LEGACY_SETTING_KEYS = Object.freeze(["skipExistingDownloads", "fullCrawlPace"]);

export const TEMPLATE_TOKENS = Object.freeze([
  { token: "{username}", description: "Account username" },
  { token: "{id}", description: "Post shortcode or story id" },
  { token: "{index}", description: "Position inside the post or story (01, 02...)" },
  { token: "{type}", description: "image or video" },
  { token: "{date}", description: "Date posted (YYYY-MM-DD)" },
  { token: "{kind}", description: "post, reel, story, highlight, profile, or saved" }
]);

function pickEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function pickTemplate(value, fallback) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || fallback;
}

export function clampQuickDownloadLimit(value) {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric) || numeric < QUICK_DOWNLOAD_LIMIT_MIN) {
    return DEFAULT_SETTINGS.maxProfilePosts;
  }

  return Math.min(QUICK_DOWNLOAD_LIMIT_MAX, numeric);
}

export function normalizeBulkPace(value) {
  const pace = value === "faster" ? "aggressive" : value;
  return pickEnum(pace, BULK_PACES, DEFAULT_SETTINGS.bulkPace);
}

export function normalizeSettings(stored = {}) {
  const source = stored && typeof stored === "object" ? stored : {};
  const duplicateMode = DUPLICATE_MODES.includes(source.duplicateMode)
    ? source.duplicateMode
    : source.skipExistingDownloads === false
      ? "none"
      : DEFAULT_SETTINGS.duplicateMode;

  return {
    themeMode: pickEnum(source.themeMode, THEME_MODES, DEFAULT_SETTINGS.themeMode),
    easyMode: Boolean(source.easyMode ?? DEFAULT_SETTINGS.easyMode),
    defaultDownloadScope: pickEnum(source.defaultDownloadScope, DOWNLOAD_SCOPES, DEFAULT_SETTINGS.defaultDownloadScope),
    confirmBeforeDownload: Boolean(source.confirmBeforeDownload ?? DEFAULT_SETTINGS.confirmBeforeDownload),
    promptForSingleDownload: Boolean(source.promptForSingleDownload ?? DEFAULT_SETTINGS.promptForSingleDownload),
    duplicateMode,
    maxProfilePosts: clampQuickDownloadLimit(source.maxProfilePosts ?? DEFAULT_SETTINGS.maxProfilePosts),
    profileMediaFilter: pickEnum(source.profileMediaFilter, MEDIA_FILTERS, DEFAULT_SETTINGS.profileMediaFilter),
    bulkPace: normalizeBulkPace(source.bulkPace ?? source.fullCrawlPace),
    folderTemplate: pickTemplate(source.folderTemplate, DEFAULT_SETTINGS.folderTemplate),
    filenameTemplate: pickTemplate(source.filenameTemplate, DEFAULT_SETTINGS.filenameTemplate),
    saveMetadataSidecar: Boolean(source.saveMetadataSidecar ?? DEFAULT_SETTINGS.saveMetadataSidecar),
    placeMetadataInSubfolder: Boolean(source.placeMetadataInSubfolder ?? DEFAULT_SETTINGS.placeMetadataInSubfolder),
    exportPostComments: Boolean(source.exportPostComments ?? DEFAULT_SETTINGS.exportPostComments),
    exportBatchReport: Boolean(source.exportBatchReport ?? DEFAULT_SETTINGS.exportBatchReport),
    metadataFilenameTemplate: pickTemplate(source.metadataFilenameTemplate, DEFAULT_SETTINGS.metadataFilenameTemplate)
  };
}

function getSyncStorage() {
  return globalThis.chrome?.storage?.sync || null;
}

export async function loadSettings() {
  const storage = getSyncStorage();
  const stored = storage ? await storage.get(null) : {};
  return normalizeSettings(stored);
}

export async function saveSettings(partial = {}) {
  const storage = getSyncStorage();
  const current = await loadSettings();
  const next = normalizeSettings({ ...current, ...partial });
  await storage.set(next);
  await storage.remove([...LEGACY_SETTING_KEYS]);
  return next;
}

export async function resetSettings() {
  const storage = getSyncStorage();
  const defaults = normalizeSettings(DEFAULT_SETTINGS);
  await storage.set(defaults);
  await storage.remove([...LEGACY_SETTING_KEYS]);
  return defaults;
}
