const pageKindPill = document.getElementById("page-kind-pill");
const headlineEl = document.getElementById("headline");
const metricsCard = document.getElementById("metrics-card");
const detailsCard = document.getElementById("details-card");
const errorCard = document.getElementById("error-card");
const totalCountEl = document.getElementById("total-count");
const imageCountEl = document.getElementById("image-count");
const videoCountEl = document.getElementById("video-count");
const pageTargetEl = document.getElementById("page-target");
const resolverSourceEl = document.getElementById("resolver-source");
const duplicateNoteEl = document.getElementById("duplicate-note");
const metadataNoteEl = document.getElementById("metadata-note");
const batchDiagnosticsBlock = document.getElementById("batch-diagnostics-block");
const batchDiagnosticsListEl = document.getElementById("batch-diagnostics-list");
const fileListEl = document.getElementById("file-list");
const errorTitleEl = document.getElementById("error-title");
const errorMessageEl = document.getElementById("error-message");
const errorSuggestionEl = document.getElementById("error-suggestion");
const downloadButton = document.getElementById("download-button");
const refreshButton = document.getElementById("refresh-button");
const settingsButton = document.getElementById("settings-button");
const crawlButton = document.getElementById("crawl-button");
const resetCrawlButton = document.getElementById("reset-crawl-button");
const crawlSummaryEl = document.getElementById("crawl-summary");
const crawlStatusActionsEl = document.getElementById("crawl-status-actions");
const crawlDiagnosticsBlock = document.getElementById("crawl-diagnostics-block");
const crawlDiagnosticsListEl = document.getElementById("crawl-diagnostics-list");
const statusEl = document.getElementById("status");
const DEFAULT_THEME_MODE = "light";

let activeTab = null;

function applyTheme(themeMode) {
  const resolvedTheme = ["light", "dark", "instagram"].includes(themeMode) ? themeMode : DEFAULT_THEME_MODE;
  document.documentElement.dataset.theme = resolvedTheme;
}

async function loadTheme() {
  const { themeMode = DEFAULT_THEME_MODE } = await chrome.storage.sync.get({ themeMode: DEFAULT_THEME_MODE });
  applyTheme(themeMode);
}

function setStatus(message, isError = false) {
  statusEl.textContent = message || "";
  statusEl.classList.toggle("error", Boolean(isError));
}

function setBusy(isBusy) {
  downloadButton.disabled = isBusy;
  refreshButton.disabled = isBusy;
  crawlButton.disabled = isBusy;
  resetCrawlButton.disabled = isBusy;
}

function setElementText(element, text) {
  const value = String(text || "").trim();
  element.textContent = value;
  element.classList.toggle("hidden", !value);
}

function isDuplicateErrorText(candidate, seenValues) {
  const normalized = String(candidate || "").trim().toLowerCase();
  return !normalized || seenValues.has(normalized);
}

function renderCrawlJob(preview) {
  const crawlJob = preview?.crawlJob || null;
  const isProfile = preview?.summary?.pageKind === "profile";

  crawlButton.classList.toggle("hidden", !isProfile);

  if (!isProfile) {
    crawlSummaryEl.classList.add("hidden");
    crawlStatusActionsEl.classList.add("hidden");
    crawlDiagnosticsBlock.classList.add("hidden");
    return;
  }

  if (!crawlJob) {
    crawlButton.textContent = "Start Full Crawl";
    crawlSummaryEl.classList.add("hidden");
    crawlStatusActionsEl.classList.add("hidden");
    crawlDiagnosticsBlock.classList.add("hidden");
    return;
  }

  crawlButton.textContent = crawlJob.status === "completed" ? "Start New Crawl" : "Resume Full Crawl";
  crawlStatusActionsEl.classList.remove("hidden");
  crawlSummaryEl.classList.remove("hidden");
  crawlSummaryEl.textContent = crawlJob.statusLine;

  crawlDiagnosticsListEl.replaceChildren();
  const diagnostics = [
    `Status: ${crawlJob.status}.`,
    `Posts processed: ${crawlJob.totalPostsResolved}.`,
    `Pending saved shortcodes: ${crawlJob.pendingShortcodes}.`,
    crawlJob.hasMore ? "More profile pages remain after the saved cursor." : "Saved cursor is at the end of the profile.",
    crawlJob.lastBatch
      ? `Last batch processed ${crawlJob.lastBatch.processedPosts} posts and queued ${crawlJob.lastBatch.queued} file${crawlJob.lastBatch.queued === 1 ? "" : "s"}.`
      : "No crawl batches have been processed yet."
  ];

  if (crawlJob.lastError) {
    diagnostics.push(`Last error: ${crawlJob.lastError}`);
  }

  crawlDiagnosticsBlock.classList.remove("hidden");
  for (const line of diagnostics) {
    const li = document.createElement("li");
    li.textContent = line;
    crawlDiagnosticsListEl.appendChild(li);
  }
}

async function getActiveInstagramTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

function renderPreview(preview) {
  errorCard.classList.add("hidden");
  metricsCard.classList.remove("hidden");
  detailsCard.classList.remove("hidden");

  pageKindPill.textContent = String(preview.summary.pageKind || "media").toUpperCase();
  headlineEl.textContent = `${preview.summary.totalCount} file${preview.summary.totalCount === 1 ? "" : "s"} ready from @${preview.summary.username || "instagram"}.`;
  totalCountEl.textContent = String(preview.summary.totalCount || 0);
  imageCountEl.textContent = String(preview.summary.imageCount || 0);
  videoCountEl.textContent = String(preview.summary.videoCount || 0);
  pageTargetEl.textContent = preview.meta.title || `@${preview.summary.username} • ${preview.summary.id}`;
  resolverSourceEl.textContent = preview.summary.source || "instagram_api";
  duplicateNoteEl.textContent = preview.summary.duplicateMode === "none"
    ? "Duplicate suppression is disabled. Previously downloaded files may be downloaded again."
    : preview.summary.duplicateCount
      ? `${preview.summary.duplicateCount} file${preview.summary.duplicateCount === 1 ? " is" : "s are"} already in local history and will be skipped.`
      : "No duplicate downloads detected in local history.";
  metadataNoteEl.textContent = preview.summary.metadataEnabled
    ? `Enabled: ${preview.summary.metadataFilename}`
    : "Disabled in settings";

  batchDiagnosticsListEl.replaceChildren();
  const batchDiagnostics = Array.isArray(preview.summary.batchDiagnostics) ? preview.summary.batchDiagnostics : [];
  if (batchDiagnostics.length > 0) {
    batchDiagnosticsBlock.classList.remove("hidden");
    for (const line of batchDiagnostics) {
      const li = document.createElement("li");
      li.textContent = line;
      batchDiagnosticsListEl.appendChild(li);
    }
  } else {
    batchDiagnosticsBlock.classList.add("hidden");
  }

  fileListEl.replaceChildren();
  for (const item of preview.items.slice(0, 3)) {
    const li = document.createElement("li");
    li.textContent = `${item.type.toUpperCase()} • ${item.filename}${item.alreadyDownloaded ? " • already downloaded" : ""}`;
    fileListEl.appendChild(li);
  }

  if (preview.items.length > 3) {
    const li = document.createElement("li");
    li.textContent = `Plus ${preview.items.length - 3} more file${preview.items.length - 3 === 1 ? "" : "s"}.`;
    fileListEl.appendChild(li);
  }

  renderCrawlJob(preview);

  setStatus("Ready.");
}

function renderError(error) {
  metricsCard.classList.add("hidden");
  detailsCard.classList.add("hidden");
  const isUnsupportedPage = error?.code === "unsupported_url";
  errorCard.classList.toggle("hidden", isUnsupportedPage);

  pageKindPill.textContent = "ERROR";
  headlineEl.textContent = "The current page could not be resolved.";
  const fallbackTitle = error?.title || "Download failed";
  const seenValues = new Set();
  setElementText(errorTitleEl, fallbackTitle);
  seenValues.add(fallbackTitle.trim().toLowerCase());

  const nextMessage = isDuplicateErrorText(error?.message, seenValues) ? "" : error?.message;
  if (nextMessage) {
    seenValues.add(nextMessage.trim().toLowerCase());
  }

  const resolvedSuggestion = error?.suggestion || "Try reloading the page and checking your Instagram session.";
  const nextSuggestion = isDuplicateErrorText(resolvedSuggestion, seenValues)
    ? ""
    : resolvedSuggestion;

  setElementText(errorMessageEl, nextMessage);
  setElementText(errorSuggestionEl, nextSuggestion);
  batchDiagnosticsBlock.classList.add("hidden");
  crawlButton.classList.add("hidden");
  crawlSummaryEl.classList.add("hidden");
  crawlStatusActionsEl.classList.add("hidden");
  crawlDiagnosticsBlock.classList.add("hidden");
  setStatus(fallbackTitle, true);
}

async function requestPreview() {
  setBusy(true);
  setStatus("Checking current page...");

  try {
    activeTab = await getActiveInstagramTab();
    if (!activeTab?.id) {
      throw new Error("No active tab was available.");
    }

    const response = await chrome.runtime.sendMessage({
      type: "GET_PAGE_PREVIEW",
      tabId: activeTab.id,
      tabUrl: activeTab.url || ""
    });

    if (!response?.ok) {
      renderError(response?.error || { title: "Preview failed", message: "Unknown error." });
      return;
    }

    renderPreview(response);
  } catch (error) {
    renderError({
      title: "Preview failed",
      message: String(error?.message || error),
      suggestion: "Make sure an Instagram tab is active in the current window."
    });
  } finally {
    setBusy(false);
  }
}

async function startDownload() {
  if (!activeTab?.id) {
    setStatus("No Instagram tab selected.", true);
    return;
  }

  setBusy(true);
  setStatus("Starting download...");

  try {
    const response = await chrome.runtime.sendMessage({
      type: "START_PAGE_DOWNLOAD",
      tabId: activeTab.id,
      tabUrl: activeTab.url || ""
    });

    if (response?.ok) {
      const count = response?.result?.downloaded || 0;
      setStatus(count === 1 ? "Download queued." : count > 1 ? `Queued ${count} downloads.` : "No new downloads queued.");
      await requestPreview();
      return;
    }

    if (response?.cancelled) {
      setStatus("Download cancelled.");
      return;
    }

    renderError(response?.error || {
      title: "Download failed",
      message: "Unknown error.",
      suggestion: "Try again after reloading the page."
    });
  } catch (error) {
    renderError({
      title: "Download failed",
      message: String(error?.message || error),
      suggestion: "Try again after reloading the page."
    });
  } finally {
    setBusy(false);
  }
}

async function startFullCrawl() {
  if (!activeTab?.id) {
    setStatus("No Instagram tab selected.", true);
    return;
  }

  setBusy(true);
  setStatus("Continuing full crawl...");

  try {
    const response = await chrome.runtime.sendMessage({
      type: "START_FULL_PROFILE_CRAWL",
      tabId: activeTab.id,
      tabUrl: activeTab.url || ""
    });

    if (response?.ok) {
      setStatus(response?.crawlJob?.hasMore ? "Crawl batch finished. Resume to continue." : "Full crawl completed.");
      await requestPreview();
      return;
    }

    if (response?.cancelled) {
      setStatus("Full crawl paused before download.");
      await requestPreview();
      return;
    }

    renderError(response?.error || {
      title: "Full crawl failed",
      message: "Unknown error.",
      suggestion: "Try again after reloading the profile page."
    });
  } catch (error) {
    renderError({
      title: "Full crawl failed",
      message: String(error?.message || error),
      suggestion: "Try again after reloading the profile page."
    });
  } finally {
    setBusy(false);
  }
}

async function resetFullCrawl() {
  if (!activeTab?.id) {
    setStatus("No Instagram tab selected.", true);
    return;
  }

  const confirmed = window.confirm("Reset the saved full crawl job for this profile?");
  if (!confirmed) {
    return;
  }

  setBusy(true);
  try {
    const response = await chrome.runtime.sendMessage({
      type: "RESET_FULL_PROFILE_CRAWL",
      tabId: activeTab.id,
      tabUrl: activeTab.url || ""
    });

    if (!response?.ok) {
      throw new Error(response?.error?.message || "Could not reset full crawl.");
    }

    setStatus("Full crawl reset.");
    await requestPreview();
  } catch (error) {
    setStatus(String(error?.message || error), true);
  } finally {
    setBusy(false);
  }
}

downloadButton.addEventListener("click", startDownload);
refreshButton.addEventListener("click", requestPreview);
settingsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
crawlButton.addEventListener("click", startFullCrawl);
resetCrawlButton.addEventListener("click", resetFullCrawl);

loadTheme()
  .catch(() => {
    applyTheme(DEFAULT_THEME_MODE);
  })
  .finally(() => {
    requestPreview();
  });