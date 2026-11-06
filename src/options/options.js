import { buildMediaFilename, buildMetadataFilename } from "../background/downloads/filenames.js";
import { BULK_PACE_DESCRIPTIONS, describeHistoryEntry, pluralize } from "../shared/labels.js";
import { MESSAGE_TYPES, sendMessage } from "../shared/messages.js";
import {
  DEFAULT_SETTINGS,
  QUICK_DOWNLOAD_LIMIT_MAX,
  QUICK_DOWNLOAD_LIMIT_MIN,
  TEMPLATE_TOKENS,
  clampQuickDownloadLimit,
  loadSettings,
  normalizeSettings,
  resetSettings,
  saveSettings
} from "../shared/settings.js";
import { applyTheme, initTheme } from "../shared/theme.js";

const TEXT_SAVE_DELAY_MS = 500;
const SAVED_BADGE_MS = 2000;
const HISTORY_LIMIT = 10;

const SAMPLE_META = { username: "natgeo", id: "C8xYz12AbCd", pageKind: "post", timestamp: 1717171717 };
const SAMPLE_ITEMS = [
  { label: "Photo", index: 0, item: { type: "image", url: "https://scontent.cdninstagram.com/sample_n.jpg", postId: "C8xYz12AbCd", timestamp: 1717171717 } },
  { label: "Video", index: 1, item: { type: "video", url: "https://scontent.cdninstagram.com/sample.mp4", postId: "C8xYz12AbCd", timestamp: 1717171717 } }
];

const form = document.getElementById("settings-form");
const saveStateEl = document.getElementById("save-state");
const paceDescriptionEl = document.getElementById("pace-description");
const tokenListEl = document.getElementById("token-list");
const filenamePreviewEl = document.getElementById("filename-preview");
const historyListEl = document.getElementById("history-list");
const historyCountEl = document.getElementById("history-count");
const navLinks = Array.from(document.querySelectorAll(".nav-link"));
const sections = Array.from(document.querySelectorAll(".section"));

let currentSettings = { ...DEFAULT_SETTINGS };
let pendingChanges = {};
let saveTimer = null;
let savedBadgeTimer = null;
let lastTemplateInput = document.getElementById("filenameTemplate");

// ---------- Form <-> settings ----------

function getField(key) {
  return form.elements.namedItem(key);
}

function readField(key) {
  const field = getField(key);
  if (!field) return undefined;

  if (field instanceof RadioNodeList) {
    return field.value || DEFAULT_SETTINGS[key];
  }
  if (field.type === "checkbox") {
    // Some switches map to string settings, e.g. duplicateMode "history"/"none".
    return field.dataset.on ? (field.checked ? field.dataset.on : field.dataset.off) : field.checked;
  }
  if (field.type === "number") {
    return clampQuickDownloadLimit(field.value);
  }
  return field.value.trim();
}

function writeField(key, value) {
  const field = getField(key);
  if (!field) return;

  if (field instanceof RadioNodeList) {
    field.value = String(value);
  } else if (field.type === "checkbox") {
    field.checked = field.dataset.on ? value === field.dataset.on : Boolean(value);
  } else {
    field.value = String(value ?? "");
  }
}

function readForm() {
  const values = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const value = readField(key);
    if (value !== undefined) values[key] = value;
  }
  return normalizeSettings({ ...currentSettings, ...values });
}

function writeForm(settings) {
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    writeField(key, settings[key]);
  }
  refreshDerivedUi();
}

// ---------- Saving ----------

function setSaveState(state, text = "") {
  clearTimeout(savedBadgeTimer);
  saveStateEl.dataset.state = state;
  saveStateEl.textContent = text || { saving: "Saving…", saved: "Saved", error: "Couldn't save" }[state] || "";
  if (state === "saved") {
    savedBadgeTimer = setTimeout(() => {
      saveStateEl.dataset.state = "idle";
    }, SAVED_BADGE_MS);
  }
}

async function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const changes = pendingChanges;
  pendingChanges = {};
  if (!Object.keys(changes).length) return;

  try {
    currentSettings = await saveSettings(changes);
    setSaveState("saved");
  } catch (error) {
    console.error("[InstagramSaver] Failed to save settings", error);
    setSaveState("error");
  }
}

function queueSave(key, delay = 0) {
  pendingChanges[key] = readField(key);
  setSaveState("saving");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, delay);
}

// ---------- Derived UI ----------

function updateDependents() {
  for (const group of document.querySelectorAll("[data-depends]")) {
    const enabled = Boolean(getField(group.dataset.depends)?.checked);
    group.classList.toggle("is-disabled", !enabled);
    for (const input of group.querySelectorAll("input")) {
      input.disabled = !enabled;
    }
  }
}

function updatePaceDescription() {
  paceDescriptionEl.textContent = BULK_PACE_DESCRIPTIONS[readField("bulkPace")] || "";
}

function updateFilenamePreview() {
  const settings = readForm();
  const rows = SAMPLE_ITEMS.map(({ label, index, item }) => [label, buildMediaFilename(item, SAMPLE_META, index, settings)]);
  if (settings.saveMetadataSidecar) {
    rows.push(["Info file", buildMetadataFilename(SAMPLE_META, settings)]);
  }

  filenamePreviewEl.replaceChildren(...rows.map(([label, path]) => {
    const li = document.createElement("li");
    const labelEl = document.createElement("span");
    labelEl.className = "label";
    labelEl.textContent = label;
    const pathEl = document.createElement("span");
    pathEl.className = "path";
    pathEl.textContent = path;
    li.append(labelEl, pathEl);
    return li;
  }));
}

function refreshDerivedUi() {
  updateDependents();
  updatePaceDescription();
  updateFilenamePreview();
}

function renderTokens() {
  tokenListEl.replaceChildren(...TEMPLATE_TOKENS.map(({ token, description }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "token";
    button.title = `Insert ${token}`;
    const code = document.createElement("code");
    code.textContent = token;
    button.append(code, description);
    button.addEventListener("click", () => insertToken(token));
    return button;
  }));
}

function insertToken(token) {
  const input = lastTemplateInput;
  if (!input || input.disabled) return;

  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  // Keep placeholders readable in the file name by separating them from the text before.
  const previous = input.value.charAt(start - 1);
  const text = previous && !/[\s_\-./]/.test(previous) ? `_${token}` : token;
  input.setRangeText(text, start, end, "end");
  input.focus();
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

// ---------- Events ----------

function onFieldChanged(event) {
  const field = event.target;
  const key = field?.name;
  if (!key || !(key in DEFAULT_SETTINGS)) return;

  const isTyping = event.type === "input" && (field.type === "text" || field.type === "number");
  if (event.type === "input" && !isTyping) {
    // Checkboxes and radios are handled by the change event.
    return;
  }

  if (event.type === "change" && (field.type === "text" || field.type === "number")) {
    // Put a sensible value back if the field was left empty or out of range.
    writeField(key, normalizeSettings({ ...currentSettings, [key]: readField(key) })[key]);
  }

  if (key === "themeMode") {
    applyTheme(readField(key));
  }

  queueSave(key, isTyping ? TEXT_SAVE_DELAY_MS : 0);
  refreshDerivedUi();
}

function onStep(event) {
  const button = event.target.closest("[data-step]");
  if (!button) return;

  const field = getField("maxProfilePosts");
  field.value = String(clampQuickDownloadLimit(Number(field.value || 0) + Number(button.dataset.step)));
  queueSave("maxProfilePosts");
}

function updateActiveNav() {
  document.querySelector(".content-header")?.classList.toggle("is-stuck", window.scrollY > 8);

  let activeId = sections[0]?.id;
  for (const section of sections) {
    if (section.getBoundingClientRect().top <= 120) {
      activeId = section.id;
    }
  }
  if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 4) {
    activeId = sections[sections.length - 1]?.id;
  }
  for (const link of navLinks) {
    link.classList.toggle("active", link.getAttribute("href") === `#${activeId}`);
  }
}

// ---------- History ----------

function formatRelativeTime(isoString) {
  const timestamp = new Date(isoString || "").getTime();
  if (!Number.isFinite(timestamp)) return "";

  const minutes = Math.round((Date.now() - timestamp) / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(timestamp).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function renderHistoryEntry(entry) {
  const { kind, scope } = describeHistoryEntry(entry);
  const li = document.createElement("li");
  li.className = "history-item";

  const pill = document.createElement("span");
  pill.className = "pill";
  pill.textContent = kind;

  const main = document.createElement("div");
  main.className = "history-main";
  const title = document.createElement("span");
  title.className = "history-title";
  title.textContent = entry.title || (entry.username ? `@${entry.username}` : "Instagram");
  const meta = document.createElement("span");
  meta.className = "history-meta";
  const counts = [`${pluralize(entry.downloaded, "file")} saved`];
  if (entry.skipped) counts.push(`${entry.skipped} skipped`);
  if (entry.failed) counts.push(`${entry.failed} failed`);
  meta.textContent = `${scope} · ${counts.join(" · ")}`;
  main.append(title, meta);

  const time = document.createElement("span");
  time.className = "history-time";
  time.textContent = formatRelativeTime(entry.recordedAt);
  time.title = entry.recordedAt ? new Date(entry.recordedAt).toLocaleString() : "";

  li.append(pill, main, time);
  return li;
}

async function loadHistory() {
  let history = [];
  try {
    const response = await sendMessage(MESSAGE_TYPES.GET_DOWNLOAD_HISTORY);
    history = response?.ok && Array.isArray(response.history) ? response.history : [];
  } catch (error) {
    console.error("[InstagramSaver] Failed to load history", error);
  }

  if (!history.length) {
    const empty = document.createElement("li");
    empty.className = "history-empty";
    empty.textContent = "Nothing downloaded yet.";
    historyListEl.replaceChildren(empty);
  } else {
    historyListEl.replaceChildren(...history.slice(0, HISTORY_LIMIT).map(renderHistoryEntry));
  }

  historyCountEl.textContent = history.length > HISTORY_LIMIT
    ? `Showing the latest ${HISTORY_LIMIT} of ${history.length} downloads.`
    : pluralize(history.length, "download") + " recorded.";
}

async function runAction(action, successText) {
  try {
    await action();
    setSaveState("saved", successText);
  } catch (error) {
    console.error("[InstagramSaver] Action failed", error);
    setSaveState("error", String(error?.message || "Something went wrong"));
  }
}

async function exportHistory() {
  const response = await sendMessage(MESSAGE_TYPES.EXPORT_DOWNLOAD_HISTORY);
  if (!response?.ok) {
    throw new Error(response?.error?.message || "Couldn't export history");
  }
}

async function clearHistory() {
  const confirmed = window.confirm("Clear your download history?\n\nThe extension will no longer know which files you already have, so they may be downloaded again.");
  if (!confirmed) throw new Error("Cancelled");

  const response = await sendMessage(MESSAGE_TYPES.CLEAR_DOWNLOAD_HISTORY);
  if (!response?.ok) {
    throw new Error(response?.error?.message || "Couldn't clear history");
  }
  await loadHistory();
}

async function resetToDefaults() {
  const confirmed = window.confirm("Reset every setting to its default? Your download history is kept.");
  if (!confirmed) throw new Error("Cancelled");

  clearTimeout(saveTimer);
  pendingChanges = {};
  currentSettings = await resetSettings();
  writeForm(currentSettings);
  applyTheme(currentSettings.themeMode);
}

function bindActions() {
  document.getElementById("export-history-button").addEventListener("click", () => {
    runAction(exportHistory, "History exported to Downloads");
  });
  document.getElementById("clear-history-button").addEventListener("click", () => {
    runAction(clearHistory, "History cleared").catch(() => {});
  });
  document.getElementById("reset-defaults-button").addEventListener("click", () => {
    runAction(resetToDefaults, "Defaults restored");
  });
}

// ---------- Startup ----------

async function init() {
  await initTheme();

  const limitField = getField("maxProfilePosts");
  limitField.min = String(QUICK_DOWNLOAD_LIMIT_MIN);
  limitField.max = String(QUICK_DOWNLOAD_LIMIT_MAX);
  document.getElementById("limit-min").textContent = String(QUICK_DOWNLOAD_LIMIT_MIN);
  document.getElementById("limit-max").textContent = String(QUICK_DOWNLOAD_LIMIT_MAX);

  renderTokens();
  bindActions();

  form.addEventListener("input", onFieldChanged);
  form.addEventListener("change", onFieldChanged);
  form.addEventListener("click", onStep);
  form.addEventListener("submit", (event) => event.preventDefault());
  form.addEventListener("focusin", (event) => {
    if (event.target.classList?.contains("template-input")) {
      lastTemplateInput = event.target;
    }
  });
  window.addEventListener("scroll", () => requestAnimationFrame(updateActiveNav), { passive: true });
  window.addEventListener("beforeunload", () => {
    if (saveTimer) flushSave();
  });

  try {
    currentSettings = await loadSettings();
  } catch (error) {
    console.error("[InstagramSaver] Failed to load settings", error);
    setSaveState("error", "Couldn't load settings");
  }
  writeForm(currentSettings);
  applyTheme(currentSettings.themeMode);

  if (location.hash) {
    document.querySelector(location.hash)?.scrollIntoView();
  }
  updateActiveNav();

  await loadHistory();
}

init();
