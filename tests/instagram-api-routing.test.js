const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const backgroundSource = fs.readFileSync(
  path.join(__dirname, "..", "background.js"),
  "utf8"
);

test("web API requests use the web host with the web app headers", () => {
  assert.match(
    backgroundSource,
    /const INSTAGRAM_WEB_API_BASE_URL = "https:\/\/www\.instagram\.com\/api\/v1";/
  );
  assert.match(backgroundSource, /"X-IG-App-ID": "936619743392459"/);
  assert.match(backgroundSource, /"X-ASBD-ID": "359341"/);
  assert.doesNotMatch(backgroundSource, /https:\/\/i\.instagram\.com\/api\/v1/);
});

test("profile lookup is built from the web API base", () => {
  const profileLookups = backgroundSource.match(
    /new URL\(`\$\{INSTAGRAM_WEB_API_BASE_URL\}\/users\/web_profile_info\/`\)/g
  ) || [];

  assert.equal(profileLookups.length, 2);
});

test("story and profile resolution use identifiers extracted from the active page first", () => {
  assert.match(backgroundSource, /async function extractInstagramPageData\(tabId, username/);
  assert.match(backgroundSource, /world: "MAIN"/);
  assert.match(backgroundSource, /await extractInstagramPageData\(tabId, descriptor\.username/);
  assert.match(backgroundSource, /pageData\?\.user\?\.id \|\| pageData\?\.user\?\.pk/);
  assert.match(backgroundSource, /pageData\?\.timeline\?\.shortcodes/);
});

test("profile page extraction supports route-provided ids and username-prefixed media links", () => {
  assert.match(backgroundSource, /value\.params\?\.username/);
  assert.match(backgroundSource, /value\.route\?\.rootView\?\.props\?\.id/);
  assert.match(backgroundSource, /pathSegments\[1\]/);
});

test("story URLs resolve all current story items instead of filtering to the URL item", () => {
  const storyPlan = backgroundSource.match(/function buildStoryPlan\(reel, descriptor, source\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(storyPlan);
  assert.match(storyPlan, /descriptor\.kind === "story" \|\| !descriptor\.storyPk/);
  assert.match(storyPlan, /\? reelItems\s+: reelItems\.filter/);
});

test("rate limits stop post and profile fallback requests", () => {
  assert.match(backgroundSource, /if \(isRateLimitError\(err\)\) \{\s+throw err;\s+\}\s+logWarn\("post_info_failed"/);
  assert.match(backgroundSource, /if \(isRateLimitError\(err\)\) \{\s+throw err;\s+\}\s+logWarn\("profile_initial_timeline_fallback_failed"/);
});
