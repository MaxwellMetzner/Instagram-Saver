const DEFAULT_SETTINGS = {
  themeMode: "light",
  easyMode: false,
  confirmBeforeDownload: true,
  saveMetadataSidecar: true,
  placeMetadataInSubfolder: false,
  exportBatchReport: false,
  exportPostComments: false,
  promptForSingleDownload: true,
  duplicateMode: "history",
  skipExistingDownloads: true,
  maxProfilePosts: 24,
  profileMediaFilter: "all",
  folderTemplate: "instagram/{username}",
  filenameTemplate: "{username}_{id}_{index}",
  metadataFilenameTemplate: "{username}_{id}_metadata"
};

const form = document.getElementById("settings-form");
const statusEl = document.getElementById("status");
const exportHistoryButton = document.getElementById("export-history-button");
const clearHistoryButton = document.getElementById("clear-history-button");
const themeModeField = document.getElementById("themeMode");

function applyTheme(themeMode) {
  const resolvedTheme = ["light", "dark", "instagram"].includes(themeMode)
    ? themeMode
    : DEFAULT_SETTINGS.themeMode;
  document.documentElement.dataset.theme = resolvedTheme;
}

function setStatus(message) {
  statusEl.textContent = message;
  if (!message) return;

  window.clearTimeout(setStatus.timeoutId);
  setStatus.timeoutId = window.setTimeout(() => {
    statusEl.textContent = "";
  }, 2200);
}

async function loadSettings() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const resolvedSettings = {
    ...settings,
    duplicateMode: ["history", "none"].includes(settings.duplicateMode)
      ? settings.duplicateMode
      : settings.skipExistingDownloads === false
        ? "none"
        : "history"
  };

  applyTheme(resolvedSettings.themeMode);

  for (const [key, fallbackValue] of Object.entries(DEFAULT_SETTINGS)) {
    const field = form.elements.namedItem(key);
    if (!field) continue;

    if (field instanceof HTMLInputElement && field.type === "checkbox") {
      field.checked = Boolean(resolvedSettings[key]);
    } else if (field instanceof HTMLInputElement && field.type === "number") {
      field.value = String(resolvedSettings[key] ?? fallbackValue);
    } else if (field instanceof HTMLSelectElement) {
      field.value = String(resolvedSettings[key] ?? fallbackValue);
    } else if (field instanceof HTMLInputElement) {
      field.value = String(resolvedSettings[key] ?? fallbackValue);
    }
  }
}

async function saveSettings(event) {
  event.preventDefault();

  const payload = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const field = form.elements.namedItem(key);
    if (!field) continue;

    if (field instanceof HTMLInputElement && field.type === "checkbox") {
      payload[key] = field.checked;
    } else if (field instanceof HTMLInputElement && field.type === "number") {
      payload[key] = Math.max(1, Number(field.value || DEFAULT_SETTINGS[key]) || DEFAULT_SETTINGS[key]);
    } else if (field instanceof HTMLSelectElement) {
      payload[key] = field.value || DEFAULT_SETTINGS[key];
    } else if (field instanceof HTMLInputElement) {
      payload[key] = field.value.trim() || DEFAULT_SETTINGS[key];
    }
  }

  await chrome.storage.sync.set(payload);
  applyTheme(payload.themeMode);
  setStatus("Settings saved.");
}

async function exportHistory() {
  const response = await chrome.runtime.sendMessage({ type: "EXPORT_DOWNLOAD_HISTORY" });
  if (!response?.ok) {
    throw new Error(response?.error?.message || "Could not export history.");
  }

  setStatus("History exported.");
}

async function clearHistory() {
  const confirmed = window.confirm("Clear the local download history used for duplicate suppression?");
  if (!confirmed) {
    return;
  }

  const response = await chrome.runtime.sendMessage({ type: "CLEAR_DOWNLOAD_HISTORY" });
  if (!response?.ok) {
    throw new Error(response?.error?.message || "Could not clear history.");
  }

  setStatus("History cleared.");
}

form.addEventListener("submit", saveSettings);
exportHistoryButton.addEventListener("click", () => {
  exportHistory().catch((error) => {
    console.error("[InstagramSaver] Failed to export history", error);
    setStatus("Failed to export history.");
  });
});
clearHistoryButton.addEventListener("click", () => {
  clearHistory().catch((error) => {
    console.error("[InstagramSaver] Failed to clear history", error);
    setStatus("Failed to clear history.");
  });
});

themeModeField.addEventListener("change", () => {
  applyTheme(themeModeField.value);
});

loadSettings().catch((error) => {
  console.error("[InstagramSaver] Failed to load settings", error);
  applyTheme(DEFAULT_SETTINGS.themeMode);
  setStatus("Failed to load settings.");
});
