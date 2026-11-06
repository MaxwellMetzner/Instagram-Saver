const BULK_SOURCES = new Set([
  "instagram_profile_bulk",
  "instagram_saved_bulk",
  "instagram_profile_full_crawl",
  "instagram_saved_full_crawl"
]);

export function isBulkSource(source) {
  return BULK_SOURCES.has(source);
}

export function buildSummary(plan) {
  const imageCount = plan.items.filter((item) => item.type === "image").length;
  const videoCount = plan.items.filter((item) => item.type === "video").length;

  return {
    username: plan.meta.username,
    id: plan.meta.id,
    pageKind: plan.meta.pageKind,
    imageCount,
    videoCount,
    totalCount: plan.items.length,
    downloadScope: plan.meta.downloadScope || "all",
    currentItem: plan.meta.currentItem || null,
    isBulk: isBulkSource(plan.meta.source)
  };
}
