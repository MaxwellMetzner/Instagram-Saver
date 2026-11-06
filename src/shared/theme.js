import { DEFAULT_SETTINGS, THEME_MODES } from "./settings.js";

const darkQuery = typeof window !== "undefined" && window.matchMedia
  ? window.matchMedia("(prefers-color-scheme: dark)")
  : null;

let currentMode = DEFAULT_SETTINGS.themeMode;

export function resolveTheme(themeMode) {
  const mode = THEME_MODES.includes(themeMode) ? themeMode : DEFAULT_SETTINGS.themeMode;
  if (mode === "system") {
    return darkQuery?.matches ? "dark" : "light";
  }

  return mode;
}

export function applyTheme(themeMode) {
  currentMode = THEME_MODES.includes(themeMode) ? themeMode : DEFAULT_SETTINGS.themeMode;
  document.documentElement.dataset.theme = resolveTheme(currentMode);
}

export async function initTheme() {
  let themeMode = DEFAULT_SETTINGS.themeMode;
  try {
    const stored = await chrome.storage.sync.get({ themeMode });
    themeMode = stored.themeMode;
  } catch {
    // Fall back to the default theme when storage is unavailable.
  }

  applyTheme(themeMode);
  darkQuery?.addEventListener("change", () => {
    if (currentMode === "system") {
      applyTheme(currentMode);
    }
  });

  chrome.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName === "sync" && changes.themeMode) {
      applyTheme(changes.themeMode.newValue);
    }
  });

  return themeMode;
}
