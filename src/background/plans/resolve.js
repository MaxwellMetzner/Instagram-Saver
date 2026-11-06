import { InstagramResolverError } from "../core/errors.js";
import { resolvePostPlan } from "../instagram/posts.js";
import { resolveProfilePlan } from "../instagram/profiles.js";
import { resolveSavedPlan } from "../instagram/saved.js";
import { resolveStoryPlan } from "../instagram/stories.js";
import { parseInstagramUrl } from "../instagram/urls.js";
import { getSettings } from "../settings.js";

export async function resolveDownloadPlan(tabUrl, settings = null, progressCallback = null, tabId = null) {
  const descriptor = parseInstagramUrl(tabUrl);
  const resolvedSettings = settings || await getSettings();

  if (descriptor.kind === "post") {
    return resolvePostPlan(tabUrl, descriptor);
  }

  if (descriptor.kind === "story" || descriptor.kind === "highlight") {
    return resolveStoryPlan(tabUrl, descriptor, tabId);
  }

  if (descriptor.kind === "profile") {
    return resolveProfilePlan(tabUrl, descriptor, resolvedSettings, progressCallback, tabId);
  }

  if (descriptor.kind === "saved") {
    return resolveSavedPlan(tabUrl, descriptor, resolvedSettings, progressCallback);
  }

  throw new InstagramResolverError(
    "unsupported_url",
    "Open an Instagram post, reel, story, highlight, profile, or saved-posts page first.",
    { tabUrl }
  );
}
