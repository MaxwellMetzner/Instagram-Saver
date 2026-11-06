export function formatProfileMediaFilterLabel(profileMediaFilter) {
  if (profileMediaFilter === "images") return "images only";
  if (profileMediaFilter === "videos") return "videos only";
  return "all media";
}

function describeProfilePaginationStopReason(stopReason, savedPosts = false) {
  const posts = savedPosts ? "saved posts" : "posts";
  const completed = `Reached the oldest of the ${posts}.`;
  const reasonMap = {
    requested_limit_reached: `Stopped at your quick-download limit; older ${posts} were left for a bulk download.`,
    instagram_reported_end: `Instagram reported there are no more ${posts}.`,
    missing_end_cursor: "Instagram said there were more pages but didn't say where they start.",
    pagination_error: `Instagram returned an error while loading more ${posts}.`,
    rate_limited: "Instagram asked us to slow down. Resume later to continue where this stopped.",
    stopped_by_user: "Paused from the popup.",
    iteration_cap: "Stopped at the extension's safety limit for page loads.",
    batch_limit_reached: `Finished this round; more ${posts} remain.`,
    bulk_completed: completed,
    crawl_completed: completed,
    initial_page_sufficient: `The first page already had enough ${posts} for your quick-download limit.`,
    initial_page_only: "Instagram returned only the first page.",
    profile_id_missing: "Couldn't load more because Instagram didn't return the account id.",
    no_profile_cursor: `Instagram didn't provide a way to load more ${posts}.`
  };

  return reasonMap[stopReason] || `Finished loading ${posts}.`;
}

export function shouldReportProfileProgress(current, total) {
  return total <= 8 || current === 1 || current === total || current % 5 === 0;
}

export function applyProfileMediaFilter(items, profileMediaFilter) {
  if (profileMediaFilter === "images") {
    return items.filter((item) => item.type === "image");
  }

  if (profileMediaFilter === "videos") {
    return items.filter((item) => item.type === "video");
  }

  return items;
}

export function buildProfileBatchDiagnostics(meta) {
  if (meta.pageKind !== "profile" && meta.pageKind !== "saved") {
    return [];
  }

  const contentLabel = meta.pageKind === "saved" ? "saved post" : "profile post";
  const diagnostics = [];
  const resolvedPosts = Number(meta.profilePostCount || 0);
  const failedPosts = Number(meta.failedPostCount || 0);
  diagnostics.push(`Resolved ${resolvedPosts} ${contentLabel}${resolvedPosts === 1 ? "" : "s"}.`);
  diagnostics.push(describeProfilePaginationStopReason(meta.pagination?.stopReason, meta.pageKind === "saved"));

  if (failedPosts > 0) {
    diagnostics.push(`${failedPosts} ${contentLabel}${failedPosts === 1 ? "" : "s"} failed to resolve.`);
  }

  if (meta.profileMediaFilter && meta.profileMediaFilter !== "all") {
    diagnostics.push(`Applied media filter: ${formatProfileMediaFilterLabel(meta.profileMediaFilter)}.`);
  }

  if (Number(meta.filteredItemCount || 0) !== Number(meta.unfilteredItemCount || 0)) {
    diagnostics.push(`Filter kept ${meta.filteredItemCount} of ${meta.unfilteredItemCount} media item${Number(meta.unfilteredItemCount || 0) === 1 ? "" : "s"}.`);
  }
  return diagnostics;
}
