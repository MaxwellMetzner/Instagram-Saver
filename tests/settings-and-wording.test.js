import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildPlannedEntries } from "../src/background/downloads/filenames.js";
import { describeBulkJob, describeHistoryEntry, formatItemNoun } from "../src/shared/labels.js";
import { DEFAULT_SETTINGS, clampQuickDownloadLimit, normalizeSettings } from "../src/shared/settings.js";
import {
  describeBulk,
  describeDownloadResult,
  describeSingleChoices
} from "../src/popup/view-model.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function listFiles(directory, extensions) {
  return readdirSync(directory).flatMap((name) => {
    const fullPath = join(directory, name);
    if (statSync(fullPath).isDirectory()) return listFiles(fullPath, extensions);
    return extensions.some((extension) => name.endsWith(extension)) ? [fullPath] : [];
  });
}

describe("settings", () => {
  test("legacy keys from older versions are migrated", () => {
    const settings = normalizeSettings({ skipExistingDownloads: false, fullCrawlPace: "faster" });
    assert.equal(settings.duplicateMode, "none");
    assert.equal(settings.bulkPace, "aggressive");
    assert.equal(normalizeSettings({ fullCrawlPace: "safer" }).bulkPace, "safer");
    assert.equal(normalizeSettings({ bulkPace: "balanced", fullCrawlPace: "safer" }).bulkPace, "balanced");
  });

  test("invalid values fall back to defaults", () => {
    const settings = normalizeSettings({
      themeMode: "neon",
      defaultDownloadScope: "some",
      profileMediaFilter: "gifs",
      filenameTemplate: "   ",
      maxProfilePosts: "abc"
    });
    assert.equal(settings.themeMode, DEFAULT_SETTINGS.themeMode);
    assert.equal(settings.defaultDownloadScope, "all");
    assert.equal(settings.profileMediaFilter, "all");
    assert.equal(settings.filenameTemplate, DEFAULT_SETTINGS.filenameTemplate);
    assert.equal(settings.maxProfilePosts, DEFAULT_SETTINGS.maxProfilePosts);
    assert.deepEqual(Object.keys(settings).sort(), Object.keys(DEFAULT_SETTINGS).sort());
  });

  test("the quick download limit is clamped to its range", () => {
    assert.equal(clampQuickDownloadLimit(500), 200);
    assert.equal(clampQuickDownloadLimit("12"), 12);
    assert.equal(clampQuickDownloadLimit(0), DEFAULT_SETTINGS.maxProfilePosts);
    assert.equal(normalizeSettings({ defaultDownloadScope: "current" }).defaultDownloadScope, "current");
  });
});

describe("file names", () => {
  test("a current-item download keeps the slide number of a full download", () => {
    const plan = {
      meta: { username: "natgeo", id: "C8xYz12AbCd", pageKind: "post" },
      items: [{ type: "image", url: "https://cdn.example.com/a_n.jpg", mediaId: "3_1", selectionIndex: 2 }]
    };
    const [entry] = buildPlannedEntries(plan, DEFAULT_SETTINGS);
    assert.equal(entry.filename, "instagram/natgeo/natgeo_C8xYz12AbCd_03.jpg");
  });
});

describe("wording", () => {
  test("item nouns are pluralised per page kind", () => {
    assert.equal(formatItemNoun("post"), "slide");
    assert.equal(formatItemNoun("post", 3), "slides");
    assert.equal(formatItemNoun("story", 2), "stories");
    assert.equal(formatItemNoun("highlight", 5), "frames");
    assert.equal(formatItemNoun("unknown", 2), "items");
  });

  test("history entries distinguish current-item, bulk, and quick downloads", () => {
    assert.equal(describeHistoryEntry({ pageKind: "post", scope: "current", position: 2, total: 5 }).scope, "Slide 2 of 5");
    assert.equal(describeHistoryEntry({ pageKind: "story", scope: "current" }).scope, "Single story");
    assert.deepEqual(
      describeHistoryEntry({ pageKind: "profile", source: "instagram_profile_full_crawl" }),
      { kind: "Profile", scope: "Bulk download", bulk: true }
    );
    assert.equal(describeHistoryEntry({ pageKind: "profile", source: "instagram_profile_batch" }).scope, "Quick download");
    assert.equal(describeHistoryEntry({ pageKind: "post", scope: "all" }).scope, "Everything");
  });

  test("bulk job states read naturally", () => {
    assert.equal(describeBulkJob(null).label, "Not started");
    const running = describeBulkJob({ status: "running", totalMediaQueued: 1, totalPostsResolved: 3 });
    assert.equal(running.tone, "working");
    assert.equal(running.detail, "1 file downloaded from 3 posts so far.");
    assert.equal(describeBulkJob({ status: "completed", scope: "saved", totalMediaQueued: 4, totalPostsResolved: 1 }).detail,
      "All done: 4 files downloaded from 1 saved post.");
    assert.equal(describeBulkJob({ status: "mystery" }).status, "paused");
  });

  test("no user-facing page or message mentions crawling", () => {
    const uiFiles = [
      ...listFiles(join(repoRoot, "src", "popup"), [".html", ".js"]),
      ...listFiles(join(repoRoot, "src", "options"), [".html", ".js"]),
      ...listFiles(join(repoRoot, "src", "content"), [".js"]),
      join(repoRoot, "src", "background", "core", "errors.js"),
      join(repoRoot, "src", "background", "download-flow.js"),
      join(repoRoot, "src", "background", "bulk", "runner.js"),
      join(repoRoot, "src", "background", "ui", "context-menu.js")
    ];
    for (const file of uiFiles) {
      assert.doesNotMatch(readFileSync(file, "utf8"), /crawl/i, `${file} mentions crawling`);
    }
  });
});

describe("popup view model", () => {
  const storyPreview = {
    summary: { pageKind: "story", totalCount: 3, imageCount: 2, videoCount: 1 },
    current: { index: 1, position: 2, total: 3, method: "screen", type: "video", alreadyDownloaded: true }
  };

  test("multi-item pages offer 'this one only' and 'all' choices", () => {
    const choices = describeSingleChoices(storyPreview, "all");
    assert.equal(choices.showCurrent, true);
    assert.equal(choices.primary, "all");
    assert.equal(choices.current.title, "This story only");
    assert.equal(choices.current.detail, "Story 2 of 3 · video · already saved");
    assert.equal(choices.all.title, "All 3 stories");
    assert.equal(choices.all.detail, "2 photos, 1 video");
    assert.equal(choices.note, "");
    assert.equal(describeSingleChoices(storyPreview, "current").primary, "current");
  });

  test("an unconfirmed slide is explained to the user", () => {
    const assumed = describeSingleChoices({
      summary: { pageKind: "post", totalCount: 4, imageCount: 4 },
      current: { index: 0, position: 1, total: 4, method: "assumed", type: "image" }
    });
    assert.match(assumed.note, /assumes the first one/);

    const unknown = describeSingleChoices({
      summary: { pageKind: "highlight", totalCount: 4, imageCount: 4 },
      current: { index: null, method: "unknown" }
    });
    assert.match(unknown.current.detail, /Checks which frame is on screen/);
    assert.match(unknown.note, /Couldn't see which frame/);
  });

  test("single-item pages only offer one download", () => {
    const choices = describeSingleChoices({ summary: { pageKind: "reel", totalCount: 1, videoCount: 1 } });
    assert.equal(choices.showCurrent, false);
    assert.equal(choices.all.title, "Download this video");
  });

  test("bulk card actions follow the job state", () => {
    const settings = { bulkPace: "balanced", profileMediaFilter: "videos", duplicateMode: "history" };
    const idle = describeBulk("profile", null, settings);
    assert.equal(idle.primary.label, "Start bulk download");
    assert.equal(idle.showReset, false);
    assert.equal(idle.settingsHint, "Speed: Balanced · Videos only");

    assert.equal(describeBulk("profile", { status: "running", isActive: true }, settings).primary.action, "pause");
    assert.equal(describeBulk("profile", { status: "paused" }, settings).primary.label, "Resume");
    assert.equal(describeBulk("saved", { status: "completed" }, settings).primary.label, "Check for new posts");

    const coolingDown = describeBulk("profile", {
      status: "rate_limited",
      resumeAfter: new Date(Date.now() + 60_000).toISOString()
    }, settings);
    assert.equal(coolingDown.primary.disabled, true);
    assert.match(coolingDown.primary.label, /^Resume after /);
  });

  test("download results mention the item that was saved", () => {
    assert.equal(
      describeDownloadResult({
        currentItem: { position: 2, total: 5 },
        result: { requested: 1, downloaded: 1, skipped: 0 },
        preview: { summary: { pageKind: "post" } }
      }),
      "Saving slide 2 of 5."
    );
    assert.equal(describeDownloadResult({ result: { requested: 3, downloaded: 2, skipped: 1 } }),
      "Saving 2 files. Skipped 1 file you already have.");
    assert.equal(describeDownloadResult({ result: { requested: 1, alreadyDownloaded: true } }), "You already have this file.");
  });
});
