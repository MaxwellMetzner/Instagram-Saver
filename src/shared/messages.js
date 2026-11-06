// Message types exchanged between the popup/options pages and the service worker.
export const MESSAGE_TYPES = Object.freeze({
  GET_PAGE_PREVIEW: "GET_PAGE_PREVIEW",
  START_PAGE_DOWNLOAD: "START_PAGE_DOWNLOAD",
  GET_BULK_STATUS: "GET_BULK_STATUS",
  START_BULK_DOWNLOAD: "START_BULK_DOWNLOAD",
  PAUSE_BULK_DOWNLOAD: "PAUSE_BULK_DOWNLOAD",
  RESET_BULK_DOWNLOAD: "RESET_BULK_DOWNLOAD",
  GET_DOWNLOAD_HISTORY: "GET_DOWNLOAD_HISTORY",
  EXPORT_DOWNLOAD_HISTORY: "EXPORT_DOWNLOAD_HISTORY",
  CLEAR_DOWNLOAD_HISTORY: "CLEAR_DOWNLOAD_HISTORY"
});

export async function sendMessage(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}
