const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const backgroundSource = fs.readFileSync(
  path.join(__dirname, "..", "background.js"),
  "utf8"
);
const popupSource = fs.readFileSync(
  path.join(__dirname, "..", "popup.js"),
  "utf8"
);

test("web API requests use the web host with the web app headers", () => {
  assert.match(
    backgroundSource,
    /const INSTAGRAM_WEB_API_BASE_URL = "https:\/\/www\.instagram\.com\/api\/v1";/
  );
  assert.match(backgroundSource, /"X-IG-App-ID": "936619743392459"/);
  assert.match(backgroundSource, /"X-ASBD-ID": "359341"/);
  assert.doesNotMatch(backgroundSource, /"X-IG-WWW-Claim": "0"/);
  assert.doesNotMatch(backgroundSource, /https:\/\/i\.instagram\.com\/api\/v1/);
});

test("profile lookup is built from the web API base", () => {
  const profileLookups = backgroundSource.match(
    /new URL\(`\$\{INSTAGRAM_WEB_API_BASE_URL\}\/users\/web_profile_info\/`\)/g
  ) || [];

  assert.equal(profileLookups.length, 2);
});

test("story user lookup uses the owner's profile URL as its API referer", () => {
  const lookupSource = backgroundSource.match(
    /async function lookupUserIdByUsername\(username, tabUrl\) \{[\s\S]*?\n\}/
  )?.[0];
  assert.ok(lookupSource);
  assert.match(lookupSource, /getInstagramApiHeaders\(getProfilePageFetchUrl\(tabUrl, username\)\)/);
});

test("Instagram server errors suggest waiting before retrying", () => {
  assert.match(backgroundSource, /Number\(details\.context\?\.status \|\| 0\) >= 500/);
  assert.match(backgroundSource, /title: "Instagram server error"/);
  assert.match(backgroundSource, /Wait a few minutes before trying again/);
});

test("download errors show the failed endpoint without query parameters", () => {
  const formatErrorRequestSource = popupSource.match(
    /function formatErrorRequest\(error\) \{[\s\S]*?\n\}/
  )?.[0];
  assert.ok(formatErrorRequestSource);

  const formatErrorRequest = new Function(
    `${formatErrorRequestSource}; return formatErrorRequest;`
  )();
  assert.equal(
    formatErrorRequest({
      context: {
        status: 500,
        url: "https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=123"
      }
    }),
    "Failed request: HTTP 500 from https://www.instagram.com/api/v1/feed/reels_media/"
  );
  assert.equal(formatErrorRequest({ context: { status: 500 } }), "");
});

test("story and profile resolution use identifiers extracted from the active page first", () => {
  assert.match(backgroundSource, /async function extractInstagramPageData\(tabId, username/);
  assert.match(backgroundSource, /world: "MAIN"/);
  assert.match(backgroundSource, /await extractInstagramPageData\(tabId, descriptor\.username/);
  assert.match(backgroundSource, /pageData\?\.user\?\.id \|\| pageData\?\.user\?\.pk/);
  assert.match(backgroundSource, /pageData\?\.timeline\?\.shortcodes/);
});

test("story resolution uses matching story data from the active page before making API requests", () => {
  assert.match(backgroundSource, /const matchingStoryReels = \[\]/);
  assert.match(backgroundSource, /storyOwner\?\.username/);
  assert.match(backgroundSource, /storyReel: matchedStoryReel/);
  assert.match(backgroundSource, /async function extractStoryPageData\(tabId, username\)/);
  assert.match(backgroundSource, /await extractStoryPageData\(tabId, descriptor\.username\)/);
  assert.match(backgroundSource, /if \(pageData\?\.storyReel\) \{\s+const plan = buildStoryPlan\(pageData\.storyReel/);
});

test("story frame fallback uses media info instead of profile and reels-feed lookups", async () => {
  const helperSource = backgroundSource.match(
    /async function fetchStoryMediaInfo\(storyPk, tabUrl\) \{[\s\S]*?\n\}/
  )?.[0];
  assert.ok(helperSource);

  let requestedUrl = null;
  const fetchStoryMediaInfo = new Function(
    "INSTAGRAM_WEB_API_BASE_URL",
    "encodeURIComponent",
    "fetchJsonWithTimeout",
    "getInstagramApiHeaders",
    "InstagramResolverError",
    `${helperSource}; return fetchStoryMediaInfo;`
  )(
    "https://www.instagram.com/api/v1",
    encodeURIComponent,
    async (url) => {
      requestedUrl = url;
      return {
        items: [
          { pk: "other-story", user: { username: "repostrandy" } },
          { pk: "4020170343087478417", user: { username: "repostrandy" } }
        ]
      };
    },
    () => ({}),
    class InstagramResolverError extends Error {
      constructor(code, message, context) {
        super(message);
        this.code = code;
        this.context = context;
      }
    }
  );
  const story = await fetchStoryMediaInfo(
    "4020170343087478417",
    "https://www.instagram.com/stories/repostrandy/4020170343087478417/"
  );

  assert.equal(story.pk, "4020170343087478417");
  assert.equal(
    requestedUrl,
    "https://www.instagram.com/api/v1/media/4020170343087478417/info/"
  );

  const resolveSource = backgroundSource.match(
    /async function resolveStoryPlan\(tabUrl, descriptor, tabId = null\) \{[\s\S]*?\n\}/
  )?.[0];
  assert.ok(resolveSource);
  assert.match(resolveSource, /if \(descriptor\.kind === "story" && descriptor\.storyPk\) \{\s+const story = await fetchStoryMediaInfo/);
  assert.ok(
    resolveSource.indexOf("fetchStoryMediaInfo") < resolveSource.indexOf("lookupUserIdByUsername")
  );
});

test("page extraction finds stories nested in Instagram's reels-media route payload", () => {
  const extractorBody = backgroundSource.match(
    /func: \(targetUsername, resultLimit\) => \{([\s\S]*?)\r?\n\s*\}\r?\n\s*\}\);/
  )?.[1];
  assert.ok(extractorBody);

  const storyReel = {
    user: { id: "123", pk: "123", username: "nyknicks" },
    items: [{ id: "456", pk: "456", media_type: 1 }]
  };
  const pageRoot = {
    require: [[null, null, null, [{
      __bbox: {
        require: [[null, null, null, [null, {
          __bbox: {
            result: {
              data: {
                xdt_api__v1__feed__reels_media: {
                  reels_media: [storyReel]
                }
              }
            }
          }
        }]]]
      }
    }]]]
  };
  const extractPageData = new Function(
    "targetUsername",
    "resultLimit",
    "window",
    "document",
    "location",
    extractorBody
  );
  const pageData = extractPageData(
    "nyknicks",
    1,
    { _sharedData: pageRoot },
    { scripts: [], querySelectorAll: () => [] },
    { href: "https://www.instagram.com/stories/nyknicks/" }
  );

  assert.equal(pageData.storyReel.items[0].pk, "456");
  assert.equal(pageData.user.id, "123");
});

test("story extraction waits briefly for delayed page hydration", async () => {
  const helperSource = backgroundSource.match(
    /async function extractStoryPageData\(tabId, username\) \{[\s\S]*?\n\}/
  )?.[0];
  assert.ok(helperSource);

  let calls = 0;
  let waits = 0;
  const extractStoryPageData = new Function(
    "extractInstagramPageData",
    "sleep",
    `${helperSource}; return extractStoryPageData;`
  )(
    async (_tabId, _username, _limit) => {
      calls += 1;
      return calls === 1 ? null : { storyReel: { items: [] } };
    },
    async () => {
      waits += 1;
    }
  );

  const pageData = await extractStoryPageData(1, "nyknicks");

  assert.ok(pageData.storyReel);
  assert.equal(calls, 2);
  assert.equal(waits, 1);
});

test("profile page extraction supports route-provided ids and username-prefixed media links", () => {
  assert.match(backgroundSource, /value\.params\?\.username/);
  assert.match(backgroundSource, /value\.route\?\.rootView\?\.props\?\.id/);
  assert.match(backgroundSource, /pathSegments\[1\]/);
});

test("saved all-posts and collection URLs use separately scoped saved-feed pagination", () => {
  assert.match(backgroundSource, /parts\[1\] === "saved"/);
  assert.match(backgroundSource, /parts\[2\] === "all-posts"/);
  assert.match(backgroundSource, /collectionId: parts\[3\]/);
  assert.match(backgroundSource, /\/feed\/saved\/posts\//);
  assert.match(backgroundSource, /\/feed\/collection\/\$\{encodeURIComponent\(collectionId\)\}\/posts\//);
  assert.match(backgroundSource, /saved:\$\{descriptor\.username\}:\$\{collection\}/);
  assert.match(backgroundSource, /fetchSavedPostsPage\(\s*descriptor\.collectionId/);
});

test("saved page URLs parse all-posts and collection identifiers", () => {
  const parserSource = backgroundSource.match(
    /function parseInstagramUrl\(url\) \{[\s\S]*?\n\}/
  )?.[0];
  assert.ok(parserSource);

  const parseInstagramUrl = new Function(`${parserSource}; return parseInstagramUrl;`)();
  assert.deepEqual(
    parseInstagramUrl("https://www.instagram.com/maxmetzner/saved/all-posts/"),
    { kind: "saved", username: "maxmetzner", collectionId: null }
  );
  assert.deepEqual(
    parseInstagramUrl("https://www.instagram.com/maxmetzner/saved/cool/18040676807565133/"),
    {
      kind: "saved",
      username: "maxmetzner",
      collectionId: "18040676807565133",
      collectionName: "Cool"
    }
  );
});

test("saved post batches and resumable crawls share post resolution without merging profile checkpoints", () => {
  assert.match(backgroundSource, /async function resolveSavedPlan/);
  assert.match(backgroundSource, /pageKind: "saved"/);
  assert.match(backgroundSource, /scope: "saved"/);
  assert.match(backgroundSource, /job\.scope === "saved"\s*\?\s*await fetchSavedPostsPage/);
  assert.match(backgroundSource, /descriptor\.kind === "saved"\)\s*\{\s*crawlJob = await createFullSavedCrawlJob/);
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
