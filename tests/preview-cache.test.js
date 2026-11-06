import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  buildPreviewCacheKey,
  getSessionCachedPreview,
  previewCache,
  setCachedPreview,
  setSessionCachedPreview
} from "../src/background/preview/cache.js";
import { getPagePreview } from "../src/background/preview/preview.js";
import { getSettings } from "../src/background/settings.js";

const tab = { id: 1, url: "https://www.instagram.com/stories/example/1001/" };

function setup() {
  const session = {};
  globalThis.chrome = {
    storage: {
      sync: { get: async (defaults) => ({ ...defaults, duplicateMode: "none", saveMetadataSidecar: false }) },
      local: { get: async (defaults) => defaults },
      session: {
        get: async (defaults) => ({ ...defaults, ...session }),
        set: async (values) => Object.assign(session, values),
        remove: async (key) => { delete session[key]; }
      }
    },
    scripting: {
      executeScript: async () => [{
        result: {
          user: { id: "42", username: "example" },
          storyReel: {
            id: "42", user: { id: "42", username: "example" },
            items: Array.from({ length: 10 }, (_, index) => ({
              pk: String(1000 + index), media_type: 1, display_url: `https://example.com/${index}.jpg`
            }))
          }
        }
      }]
    }
  };
  return session;
}

afterEach(() => {
  previewCache.clear();
  delete globalThis.chrome;
});

test("session previews expire after 15 seconds, including across service-worker restarts", async (t) => {
  setup();
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  await setSessionCachedPreview(1, "key", tab.url, { items: [1] });
  assert.deepEqual(await getSessionCachedPreview(1, "key", tab.url), { items: [1] });
  now += 14999;
  assert.ok(await getSessionCachedPreview(1, "key", tab.url));
  now += 1;
  assert.equal(await getSessionCachedPreview(1, "key", tab.url), null);
});

test("legacy session entries with no expiry cannot pin an old one-frame preview", async () => {
  const session = setup();
  session.pagePreviewByTab = { "1": { cacheKey: "key", tabUrl: tab.url, preview: { items: [1] } } };
  assert.equal(await getSessionCachedPreview(1, "key", tab.url), null);
});

test("force refresh bypasses both caches and replaces the stale count with the full reel", async () => {
  setup();
  const settings = await getSettings();
  const key = buildPreviewCacheKey(tab.url, settings);
  const old = { summary: { pageKind: "story" }, items: [{ mediaId: "1001" }] };
  setCachedPreview(key, old);
  await setSessionCachedPreview(1, key, tab.url, old);
  assert.equal((await getPagePreview(tab)).items.length, 1);
  const refreshed = await getPagePreview(tab, true);
  assert.equal(refreshed.items.length, 10);
  assert.equal(refreshed.current.position, 2);
  assert.equal((await getSessionCachedPreview(1, key, tab.url)).items.length, 10);
});
