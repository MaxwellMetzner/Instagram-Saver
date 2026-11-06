import { getJitteredDelayMs, sleep } from "../core/utils.js";
import { normalizeBulkPace } from "../../shared/settings.js";

export const BULK_PACING_PROFILES = {
  safer: {
    pageFetchDelayRangeMs: [1200, 2200],
    postResolveDelayRangeMs: [320, 700],
    batchDelayRangeMs: [1800, 3000],
    rateLimitCooldownMs: 30 * 60 * 1000
  },
  balanced: {
    pageFetchDelayRangeMs: [700, 1400],
    postResolveDelayRangeMs: [140, 320],
    batchDelayRangeMs: [900, 1700],
    rateLimitCooldownMs: 20 * 60 * 1000
  },
  aggressive: {
    pageFetchDelayRangeMs: [250, 650],
    postResolveDelayRangeMs: [0, 120],
    batchDelayRangeMs: [300, 700],
    rateLimitCooldownMs: 15 * 60 * 1000
  }
};

function getBulkPacingProfile(bulkPace) {
  return BULK_PACING_PROFILES[normalizeBulkPace(bulkPace)];
}

export async function pauseForBulkStep(settings, stepKey) {
  const profile = getBulkPacingProfile(settings?.bulkPace);
  const delayMs = getJitteredDelayMs(profile?.[stepKey]);
  if (delayMs > 0) {
    await sleep(delayMs);
  }
}

export function buildRateLimitResumeAfter(errorDetails, settings) {
  const retryAfterSeconds = Number(errorDetails?.context?.retryAfterSeconds || 0);
  const profile = getBulkPacingProfile(settings?.bulkPace);
  const cooldownMs = retryAfterSeconds > 0
    ? retryAfterSeconds * 1000
    : profile.rateLimitCooldownMs;

  return new Date(Date.now() + cooldownMs).toISOString();
}

export function isBulkCooldownActive(job) {
  if (!job?.resumeAfter) {
    return false;
  }

  const resumeAt = new Date(job.resumeAfter).getTime();
  return Number.isFinite(resumeAt) && resumeAt > Date.now();
}
