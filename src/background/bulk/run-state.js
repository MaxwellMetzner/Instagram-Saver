// In-memory state for bulk downloads running in this service worker instance.
const activeBulkJobs = new Set();
const requestedBulkJobStops = new Set();
const liveProgress = new Map();

function getBulkRunKey(key) {
  return String(key || "").trim().toLowerCase();
}

export function isBulkJobActive(key) {
  return activeBulkJobs.has(getBulkRunKey(key));
}

export function markBulkJobActive(key) {
  activeBulkJobs.add(getBulkRunKey(key));
}

export function clearBulkJobActive(key) {
  activeBulkJobs.delete(getBulkRunKey(key));
  liveProgress.delete(getBulkRunKey(key));
}

export function requestBulkJobStop(key) {
  requestedBulkJobStops.add(getBulkRunKey(key));
}

export function clearBulkJobStop(key) {
  requestedBulkJobStops.delete(getBulkRunKey(key));
}

export function isBulkJobStopRequested(key) {
  return requestedBulkJobStops.has(getBulkRunKey(key));
}

export function setBulkProgress(key, progress) {
  const runKey = getBulkRunKey(key);
  liveProgress.set(runKey, {
    ...(liveProgress.get(runKey) || {}),
    ...progress,
    updatedAt: new Date().toISOString()
  });
}

export function getBulkProgress(key) {
  return liveProgress.get(getBulkRunKey(key)) || null;
}
