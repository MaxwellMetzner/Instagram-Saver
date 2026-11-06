import { MESSAGE_TYPES, sendMessage } from "../shared/messages.js";
import { DEFAULT_SETTINGS, loadSettings } from "../shared/settings.js";
import { initTheme } from "../shared/theme.js";
import {
  describeBulk,
  describeDownloadResult,
  describeDuplicates,
  describePage,
  describeQuickDownload,
  describeSingleChoices,
  formatErrorRequest,
  isBulkPage
} from "./view-model.js";

const BULK_POLL_INTERVAL_MS = 1500;
const FILE_LIST_LIMIT = 6;

const $ = (id) => document.getElementById(id);

const el = {
  subtitle: $("page-subtitle"),
  refresh: $("refresh-button"),
  settings: $("settings-button"),
  loadingCard: $("loading-card"),
  pageCard: $("page-card"),
  pageKind: $("page-kind-pill"),
  pageOwner: $("page-owner"),
  pageTitle: $("page-title"),
  totalCount: $("total-count"),
  imageCount: $("image-count"),
  videoCount: $("video-count"),
  duplicateCount: $("duplicate-count"),
  singleCard: $("single-card"),
  currentButton: $("download-current-button"),
  currentTitle: $("download-current-title"),
  currentDetail: $("download-current-detail"),
  allButton: $("download-all-button"),
  allTitle: $("download-all-title"),
  allDetail: $("download-all-detail"),
  currentNote: $("current-note"),
  quickCard: $("quick-card"),
  quickDescription: $("quick-description"),
  quickButton: $("quick-download-button"),
  bulkCard: $("bulk-card"),
  bulkChip: $("bulk-status-chip"),
  bulkExplainer: $("bulk-explainer"),
  bulkProgress: $("bulk-progress"),
  bulkProgressFill: $("bulk-progress-fill"),
  bulkProgressText: $("bulk-progress-text"),
  bulkStats: $("bulk-stats"),
  bulkPosts: $("bulk-posts"),
  bulkFiles: $("bulk-files"),
  bulkSkipped: $("bulk-skipped"),
  bulkDetail: $("bulk-detail"),
  bulkPrimary: $("bulk-primary-button"),
  bulkReset: $("bulk-reset-button"),
  bulkSettingsHint: $("bulk-settings-hint"),
  errorCard: $("error-card"),
  errorTitle: $("error-title"),
  errorMessage: $("error-message"),
  errorSuggestion: $("error-suggestion"),
  errorRequest: $("error-request"),
  errorDiagnostics: $("error-diagnostics-list"),
  detailsCard: $("details-card"),
  duplicateNote: $("duplicate-note"),
  metadataNote: $("metadata-note"),
  resolverSource: $("resolver-source"),
  fileList: $("file-list"),
  batchDiagnosticsBlock: $("batch-diagnostics-block"),
  batchDiagnosticsList: $("batch-diagnostics-list"),
  status: $("status")
};

const state = {
  tab: null,
  preview: null,
  settings: { ...DEFAULT_SETTINGS },
  busy: false,
  pollTimer: null
};

function show(element, visible) {
  element.classList.toggle("hidden", !visible);
}

function setText(element, text) {
  const value = String(text || "").trim();
  element.textContent = value;
  show(element, Boolean(value));
}

function setStatus(message, isError = false) {
  el.status.textContent = message || "";
  el.status.classList.toggle("error", Boolean(isError));
}

function fillList(listElement, lines) {
  listElement.replaceChildren(...lines.map((line) => {
    const li = document.createElement("li");
    li.textContent = line;
    return li;
  }));
}

function setBusy(isBusy) {
  state.busy = isBusy;
  for (const button of [el.refresh, el.currentButton, el.allButton, el.quickButton, el.bulkReset]) {
    button.disabled = isBusy;
  }
  if (isBusy) {
    el.bulkPrimary.disabled = true;
  } else if (state.preview) {
    renderBulk(state.preview.bulkJob);
  }
}

function showOnly(...visibleCards) {
  for (const card of [el.loadingCard, el.pageCard, el.singleCard, el.quickCard, el.bulkCard, el.errorCard, el.detailsCard]) {
    show(card, visibleCards.includes(card));
  }
}

function tabPayload() {
  return { tabId: state.tab?.id, tabUrl: state.tab?.url || "" };
}

function openSettings(section = "") {
  if (!section) {
    chrome.runtime.openOptionsPage();
    return;
  }

  chrome.tabs.create({ url: chrome.runtime.getURL(`src/options/options.html#${section}`) });
}

// ---------- Rendering ----------

function renderPageCard(preview) {
  const page = describePage(preview);
  const summary = preview.summary;
  el.pageKind.textContent = page.kindLabel;
  el.pageOwner.textContent = page.owner;
  setText(el.pageTitle, page.title);
  el.totalCount.textContent = String(summary.totalCount || 0);
  el.imageCount.textContent = String(summary.imageCount || 0);
  el.videoCount.textContent = String(summary.videoCount || 0);
  el.duplicateCount.textContent = String(summary.duplicateCount || 0);
  show(el.duplicateCount.parentElement, page.showDuplicates);
}

function renderSingle(preview) {
  const choices = describeSingleChoices(preview, state.settings.defaultDownloadScope);
  show(el.currentButton, choices.showCurrent);

  if (choices.current) {
    el.currentTitle.textContent = choices.current.title;
    el.currentDetail.textContent = choices.current.detail;
  }
  el.allTitle.textContent = choices.all.title;
  el.allDetail.textContent = choices.all.detail;
  setText(el.currentNote, choices.note);

  const currentFirst = choices.showCurrent && choices.primary === "current";
  el.currentButton.classList.toggle("primary", currentFirst);
  el.allButton.classList.toggle("primary", !currentFirst);
  // Keep the emphasised option on top.
  el.currentButton.parentElement.prepend(currentFirst ? el.currentButton : el.allButton);
}

function renderQuick(preview) {
  const quick = describeQuickDownload(preview);
  el.quickDescription.textContent = quick.description;
  el.quickButton.textContent = quick.buttonLabel;
  el.quickButton.disabled = state.busy || quick.disabled;
}

function renderBulk(bulkJob) {
  const pageKind = state.preview?.summary?.pageKind;
  if (!isBulkPage(pageKind)) {
    stopPolling();
    return;
  }

  const bulk = describeBulk(pageKind, bulkJob, state.settings);
  el.bulkExplainer.textContent = bulk.explainer;
  el.bulkChip.textContent = bulk.chip.label;
  el.bulkChip.dataset.tone = bulk.chip.tone;

  if (bulk.progress) {
    show(el.bulkProgress, true);
    const track = el.bulkProgressFill.parentElement;
    track.classList.toggle("indeterminate", bulk.progress.percent === null);
    el.bulkProgressFill.style.width = bulk.progress.percent === null ? "" : `${bulk.progress.percent}%`;
    el.bulkProgressText.textContent = bulk.progress.text;
  } else {
    show(el.bulkProgress, false);
  }

  if (bulk.stats) {
    show(el.bulkStats, true);
    el.bulkPosts.textContent = String(bulk.stats.posts);
    el.bulkFiles.textContent = String(bulk.stats.files);
    el.bulkSkipped.textContent = String(bulk.stats.skipped);
  } else {
    show(el.bulkStats, false);
  }

  setText(el.bulkDetail, bulk.isActive ? "" : bulk.detail);
  el.bulkPrimary.textContent = bulk.primary.label;
  el.bulkPrimary.dataset.action = bulk.primary.action;
  el.bulkPrimary.disabled = state.busy || bulk.primary.disabled;
  show(el.bulkReset, bulk.showReset);

  el.bulkSettingsHint.replaceChildren(`${bulk.settingsHint} · `);
  const link = document.createElement("a");
  link.href = "#";
  link.textContent = "Change";
  link.addEventListener("click", (event) => {
    event.preventDefault();
    openSettings("bulk");
  });
  el.bulkSettingsHint.appendChild(link);

  if (bulk.isActive) {
    startPolling();
  } else {
    stopPolling();
  }
}

function renderDetails(preview) {
  const summary = preview.summary;
  el.duplicateNote.textContent = describeDuplicates(summary);
  el.metadataNote.textContent = summary.metadataEnabled
    ? summary.metadataFilename || "Saved alongside the media"
    : "Off (turn on in Settings)";
  el.resolverSource.textContent = summary.source || "Instagram";

  const currentIndex = Number.isInteger(preview.current?.index) ? preview.current.index : -1;
  const rows = preview.items.slice(0, FILE_LIST_LIMIT).map((item, index) => {
    const li = document.createElement("li");
    li.classList.toggle("is-current", index === currentIndex);
    const type = document.createElement("span");
    type.className = "file-type";
    type.textContent = item.type === "video" ? "Video" : "Photo";
    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = item.filename;
    name.title = item.filename;
    li.append(type, name);
    if (item.alreadyDownloaded || index === currentIndex) {
      const badge = document.createElement("span");
      badge.className = "file-badge";
      badge.textContent = index === currentIndex ? "on screen" : "saved";
      li.appendChild(badge);
    }
    return li;
  });
  if (preview.items.length > FILE_LIST_LIMIT) {
    const more = document.createElement("li");
    more.className = "muted";
    more.textContent = `…and ${preview.items.length - FILE_LIST_LIMIT} more`;
    rows.push(more);
  }
  el.fileList.replaceChildren(...rows);

  const diagnostics = Array.isArray(summary.batchDiagnostics) ? summary.batchDiagnostics : [];
  fillList(el.batchDiagnosticsList, diagnostics);
  show(el.batchDiagnosticsBlock, diagnostics.length > 0);
}

function renderPreview(preview) {
  state.preview = preview;
  const bulkPage = isBulkPage(preview.summary.pageKind);
  showOnly(el.pageCard, bulkPage ? el.quickCard : el.singleCard, ...(bulkPage ? [el.bulkCard] : []), el.detailsCard);

  renderPageCard(preview);
  if (bulkPage) {
    renderQuick(preview);
    renderBulk(preview.bulkJob);
  } else {
    stopPolling();
    renderSingle(preview);
  }
  renderDetails(preview);
  el.subtitle.textContent = "Ready";
}

function renderError(error) {
  state.preview = null;
  stopPolling();
  showOnly(el.errorCard);

  const unsupported = error?.code === "unsupported_url";
  el.errorCard.classList.toggle("info", unsupported);
  el.subtitle.textContent = unsupported ? "Nothing to download here" : "Something went wrong";

  const title = unsupported ? "Nothing to download on this page" : error?.title || "Something went wrong";
  const seen = new Set([title.trim().toLowerCase()]);
  const pick = (text) => {
    const value = String(text || "").trim();
    if (!value || seen.has(value.toLowerCase())) return "";
    seen.add(value.toLowerCase());
    return value;
  };

  el.errorTitle.textContent = title;
  setText(el.errorMessage, pick(error?.message));
  setText(el.errorSuggestion, pick(error?.suggestion || "Reload the Instagram page and make sure you're logged in."));
  setText(el.errorRequest, formatErrorRequest(error));
  const diagnostics = Array.isArray(error?.diagnostics) ? error.diagnostics.filter(Boolean) : [];
  fillList(el.errorDiagnostics, diagnostics);
  show(el.errorDiagnostics, diagnostics.length > 0);
  setStatus(unsupported ? "" : title, !unsupported);
}

// ---------- Bulk status polling ----------

function stopPolling() {
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
}

function startPolling() {
  if (state.pollTimer) return;

  state.pollTimer = setTimeout(async () => {
    state.pollTimer = null;
    try {
      const response = await sendMessage(MESSAGE_TYPES.GET_BULK_STATUS, tabPayload());
      if (response?.ok && state.preview) {
        state.preview = { ...state.preview, bulkJob: response.bulkJob };
        renderBulk(response.bulkJob);
      }
    } catch {
      // The service worker may restart; try again on the next tick.
      startPolling();
    }
  }, BULK_POLL_INTERVAL_MS);
}

// ---------- Actions ----------

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function requestPreview({ quiet = false, forceRefresh = false } = {}) {
  setBusy(true);
  if (!quiet) {
    showOnly(el.loadingCard);
    el.subtitle.textContent = "Checking this page…";
    setStatus("");
  }

  try {
    state.tab = await getActiveTab();
    if (!state.tab?.id) {
      throw new Error("No active tab was found.");
    }

    const response = await sendMessage(MESSAGE_TYPES.GET_PAGE_PREVIEW, { ...tabPayload(), forceRefresh });
    if (response?.ok) {
      renderPreview(response);
    } else {
      renderError(response?.error || { title: "Couldn't check this page", message: "Unknown error." });
    }
  } catch (error) {
    renderError({
      title: "Couldn't check this page",
      message: String(error?.message || error),
      suggestion: "Make sure an Instagram tab is open and active in this window."
    });
  } finally {
    setBusy(false);
  }
}

async function downloadPage(scope) {
  if (!state.tab?.id) return;

  setBusy(true);
  setStatus(scope === "current" ? "Finding the item on screen…" : "Starting download…");

  try {
    const response = await sendMessage(MESSAGE_TYPES.START_PAGE_DOWNLOAD, { ...tabPayload(), scope });
    if (response?.ok) {
      await requestPreview({ quiet: true });
      setStatus(describeDownloadResult(response));
      return;
    }

    if (response?.cancelled) {
      setStatus("Download cancelled.");
      return;
    }

    renderError(response?.error || { title: "Download failed", message: "Unknown error." });
  } catch (error) {
    renderError({
      title: "Download failed",
      message: String(error?.message || error),
      suggestion: "Reload the Instagram page and try again."
    });
  } finally {
    setBusy(false);
  }
}

async function runBulkAction(type, pendingMessage) {
  if (!state.tab?.id) return null;

  setBusy(true);
  setStatus(pendingMessage);
  try {
    const response = await sendMessage(type, tabPayload());
    if (!response?.ok) {
      setStatus(response?.error?.message || "That didn't work. Try again.", true);
      return null;
    }

    if (state.preview) {
      state.preview = { ...state.preview, bulkJob: response.bulkJob ?? null };
    }
    return response;
  } catch (error) {
    setStatus(String(error?.message || error), true);
    return null;
  } finally {
    setBusy(false);
  }
}

async function onBulkPrimary() {
  if (el.bulkPrimary.dataset.action === "pause") {
    const response = await runBulkAction(MESSAGE_TYPES.PAUSE_BULK_DOWNLOAD, "Pausing…");
    if (response) {
      setStatus(response.bulkJob?.status === "stopping" ? "Pausing after the current post…" : "Paused.");
    }
    return;
  }

  const response = await runBulkAction(MESSAGE_TYPES.START_BULK_DOWNLOAD, "Starting bulk download…");
  if (!response) return;

  if (response.rateLimited) {
    setStatus("Instagram asked us to slow down. Try again after the cool-down.");
  } else if (response.alreadyRunning) {
    setStatus("Already running.");
  } else {
    setStatus("Running in the background. You can close this popup.");
  }
}

async function onBulkReset() {
  const saved = state.preview?.summary?.pageKind === "saved";
  const confirmed = window.confirm(
    `Start the bulk download for ${saved ? "your saved posts" : "this profile"} over from the newest post?\n\nFiles you already downloaded are still skipped if duplicate skipping is on.`
  );
  if (!confirmed) return;

  const response = await runBulkAction(MESSAGE_TYPES.RESET_BULK_DOWNLOAD, "Resetting…");
  if (response) {
    setStatus("Progress cleared. Start whenever you're ready.");
  }
}

el.refresh.addEventListener("click", () => requestPreview({ forceRefresh: true }));
el.settings.addEventListener("click", () => openSettings());
el.currentButton.addEventListener("click", () => downloadPage("current"));
el.allButton.addEventListener("click", () => downloadPage("all"));
el.quickButton.addEventListener("click", () => downloadPage("all"));
el.bulkPrimary.addEventListener("click", onBulkPrimary);
el.bulkReset.addEventListener("click", onBulkReset);
window.addEventListener("pagehide", stopPolling);

(async () => {
  await initTheme();
  try {
    state.settings = await loadSettings();
  } catch {
    state.settings = { ...DEFAULT_SETTINGS };
  }
  await requestPreview();
})();
