import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { extractInstagramPageData, extractStoryPageData } from "../src/background/instagram/page-data.js";
import { fetchStoryPageReels } from "../src/background/instagram/story-page-api.js";
import { resolveStoryPlan } from "../src/background/instagram/stories.js";
import { parseInstagramUrl } from "../src/background/instagram/urls.js";
import { locateCurrentItem, selectCurrentItem } from "../src/background/plans/selection.js";

const storyUrl = "https://www.instagram.com/stories/example/1003/";
const highlightUrl = "https://www.instagram.com/stories/highlights/900/";
const user = { id: "42", username: "example" };

function makeReel(count = 10, id = "42") {
  return {
    id, user,
    items: Array.from({ length: count }, (_, index) => ({
      pk: String(1000 + index),
      user,
      media_type: 1,
      image_versions2: { candidates: [{ url: `https://example.com/story_${index}.jpg` }] }
    }))
  };
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function fastWaits(t) {
  const delays = [];
  const setTimer = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    delays.push(delay);
    return setTimer(callback, delay === 250 || delay === 500 ? 0 : delay, ...args);
  });
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "info", () => {});
  return delays;
}

function mockPage(pageData, pageQuery = { ok: true, reels: [] }) {
  globalThis.chrome = {
    scripting: {
      executeScript: async ({ args }) => [{
        result: args[0] === "story" || args[0] === "highlight"
          ? typeof pageQuery === "function" ? pageQuery(args) : pageQuery
          : typeof pageData === "function" ? pageData() : pageData
      }]
    }
  };
}

afterEach(() => {
  delete globalThis.chrome;
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.location;
});

test("a story deep link resolves the full reel, then current-only selects the URL frame", async (t) => {
  fastWaits(t);
  mockPage(null, { ok: true, reels: [makeReel()] });
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requests.push(url);
    assert.match(url, /\/media\/1003\/info\//);
    return response({ items: [{ ...makeReel().items[3], pk: undefined, id: "1003_42" }] });
  });
  const descriptor = parseInstagramUrl(storyUrl);
  const plan = await resolveStoryPlan(storyUrl, descriptor, 1);
  assert.equal(plan.items.length, 10);
  assert.equal(plan.meta.ownerId, "42");
  assert.equal(requests.length, 1);
  const current = selectCurrentItem(plan, await locateCurrentItem(descriptor, plan.items, 1));
  assert.equal(current.items.length, 1);
  assert.equal(current.items[0].mediaId, "1003");
  assert.equal(current.items[0].selectionIndex, 3);
  assert.equal(current.meta.currentItem.total, 10);
});

test("a loaded full reel requires no API requests", async (t) => {
  fastWaits(t);
  mockPage({ user, storyReel: makeReel() });
  t.mock.method(globalThis, "fetch", () => assert.fail("Unexpected API request"));
  const plan = await resolveStoryPlan(storyUrl, parseInstagramUrl(storyUrl), 1);
  assert.equal(plan.items.length, 10);
  assert.equal(plan.meta.source, "instagram_story_page_data");
});

test("distinct story frames are retained even when they reuse the same image URL", async (t) => {
  fastWaits(t);
  const reel = makeReel(2);
  reel.items[1].image_versions2 = reel.items[0].image_versions2;
  mockPage({ user, storyReel: reel });
  const plan = await resolveStoryPlan(storyUrl, parseInstagramUrl(storyUrl), 1);
  assert.equal(plan.items.length, 2);
  assert.notEqual(plan.items[0].mediaId, plan.items[1].mediaId);
});

test("a profile-opened highlight uses the page query and matches its exact reel", async (t) => {
  fastWaits(t);
  mockPage(null, { ok: true, reels: [makeReel(2, "highlight:901"), makeReel(17, "highlight:900")] });
  t.mock.method(globalThis, "fetch", () => assert.fail("Highlight should not use REST"));
  const plan = await resolveStoryPlan(highlightUrl, parseInstagramUrl(highlightUrl), 1);
  assert.equal(plan.items.length, 17);
  assert.equal(plan.meta.source, "instagram_story_page_graphql");
});

test("an early owner-lookup 404 is retried instead of reporting deleted content", async (t) => {
  const delays = fastWaits(t);
  const url = "https://www.instagram.com/stories/example/";
  mockPage(null, { ok: true, reels: [makeReel()] });
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.match(url, /web_profile_info/);
    return ++requests === 1 ? response({}, 404) : response({ data: { user } });
  });
  const plan = await resolveStoryPlan(url, parseInstagramUrl(url), 1);
  assert.equal(plan.items.length, 10);
  assert.equal(requests, 2);
  assert.equal(delays.filter((delay) => delay === 500).length, 1);
});

test("REST fallback retries a transient 500 and accepts reels_media arrays", async (t) => {
  const delays = fastWaits(t);
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.match(url, /feed\/reels_media/);
    return ++requests === 1 ? response({}, 500) : response({ reels_media: [makeReel(17, "highlight:900")] });
  });
  const plan = await resolveStoryPlan(highlightUrl, parseInstagramUrl(highlightUrl));
  assert.equal(plan.items.length, 17);
  assert.equal(requests, 2);
  assert.ok(delays.includes(500));
});

test("legacy reels maps can identify a highlight by its map key", async (t) => {
  fastWaits(t);
  const reel = makeReel(17);
  delete reel.id;
  t.mock.method(globalThis, "fetch", async () => response({ reels: { "highlight:900": reel } }));
  const plan = await resolveStoryPlan(highlightUrl, parseInstagramUrl(highlightUrl));
  assert.equal(plan.items.length, 17);
});

test("the page query waits once if Instagram's query module is still loading", async (t) => {
  const delays = fastWaits(t);
  let queries = 0;
  mockPage(null, () => ++queries === 1
    ? { ok: false, code: "story_page_not_ready", message: "Still loading" }
    : { ok: true, reels: [makeReel(17, "highlight:900")] });
  t.mock.method(globalThis, "fetch", () => assert.fail("No REST fallback needed"));
  const plan = await resolveStoryPlan(highlightUrl, parseInstagramUrl(highlightUrl), 1);
  assert.equal(plan.items.length, 17);
  assert.equal(queries, 2);
  assert.equal(delays.filter((delay) => delay === 500).length, 1);
});

test("single-frame media info is never returned as an all-stories success", async (t) => {
  fastWaits(t);
  t.mock.method(globalThis, "fetch", async (url) =>
    response(url.includes("/media/1003/") ? { items: [makeReel().items[3]] } : { reels: {} }));
  await assert.rejects(
    resolveStoryPlan(storyUrl, parseInstagramUrl(storyUrl)),
    (error) => error.code === "story_unavailable"
  );
});

test("missing media URLs cannot silently turn a multi-frame reel into one photo", async (t) => {
  fastWaits(t);
  const incomplete = makeReel();
  incomplete.items.slice(1).forEach((item) => delete item.image_versions2);
  mockPage({ user, storyReel: incomplete }, { ok: true, reels: [makeReel()] });
  t.mock.method(globalThis, "fetch", () => assert.fail("Page query should resolve the full list"));
  const plan = await resolveStoryPlan(storyUrl, parseInstagramUrl(storyUrl), 1);
  assert.equal(plan.items.length, 10);
  assert.equal(plan.meta.source, "instagram_story_page_graphql");
});

test("page hydration retains an owner ID and waits past a known partial reel", async (t) => {
  fastWaits(t);
  let calls = 0;
  mockPage(() => {
    calls += 1;
    if (calls === 1) return { user };
    if (calls === 2) return null;
    if (calls === 3) return { storyReel: { ...makeReel(1), media_count: 10 } };
    return { storyReel: makeReel() };
  });
  const data = await extractStoryPageData(1, "example");
  assert.equal(calls, 4);
  assert.equal(data.user.id, "42");
  assert.equal(data.storyReel.items.length, 10);
});

test("SPA story navigation can read the rendered owner ID before a frame appears in the URL", async () => {
  globalThis.window = {};
  globalThis.location = { href: "https://www.instagram.com/stories/example/" };
  const ownerLink = {
    href: "https://www.instagram.com/example/",
    __reactFiber$test: { memoizedProps: {}, return: {
      memoizedProps: { username: "example", userID: "42", unrelatedData: "not-returned" }, return: null
    } }
  };
  globalThis.document = { scripts: [], querySelectorAll: () => [ownerLink] };
  globalThis.chrome = {
    scripting: { executeScript: async ({ func, args }) => [{ result: await func(...args) }] }
  };
  const data = await extractInstagramPageData(1, "example");
  assert.equal(data.user.id, "42");
  assert.equal(data.storyReel, null);
  assert.doesNotMatch(JSON.stringify(data), /not-returned/);
});

test("a media-info wrapper and an unrelated rendered user are not a complete story reel", async () => {
  globalThis.window = { _sharedData: { mediaInfo: { user, items: [makeReel().items[0]] } } };
  globalThis.location = { href: storyUrl };
  globalThis.document = {
    scripts: [],
    querySelectorAll: () => [{
      href: "https://www.instagram.com/example/",
      __reactFiber$test: { memoizedProps: { username: "someoneelse", userID: "99" }, return: null }
    }]
  };
  globalThis.chrome = {
    scripting: { executeScript: async ({ func, args }) => [{ result: await func(...args) }] }
  };
  const data = await extractInstagramPageData(1, "example");
  assert.equal(data.user.id, "42");
  assert.equal(data.storyReel, null);
});

test("late hydration can recover from failed fallback endpoints", async (t) => {
  fastWaits(t);
  let reads = 0;
  mockPage(() => ++reads <= 8 ? null : { user, storyReel: makeReel(17, "highlight:900") });
  t.mock.method(globalThis, "fetch", async () => response({}, 404));
  const plan = await resolveStoryPlan(highlightUrl, parseInstagramUrl(highlightUrl), 1);
  assert.equal(plan.items.length, 17);
  assert.equal(plan.meta.source, "instagram_story_page_data");
});

test("rate limits stop page-query fallbacks immediately", async (t) => {
  fastWaits(t);
  mockPage(null, { ok: false, code: "http_429", context: { status: 429, retryAfterSeconds: 30 } });
  t.mock.method(globalThis, "fetch", () => assert.fail("Must not bypass a rate limit"));
  await assert.rejects(resolveStoryPlan(highlightUrl, parseInstagramUrl(highlightUrl), 1),
    (error) => error.code === "http_429" && error.context.retryAfterSeconds === 30);
});

test("REST rate limits are not retried", async (t) => {
  const delays = fastWaits(t);
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    return response({}, 429);
  });
  await assert.rejects(resolveStoryPlan(highlightUrl, parseInstagramUrl(highlightUrl)),
    (error) => error.code === "http_429");
  assert.equal(requests, 1);
  assert.ok(!delays.includes(500));
});

test("a different account or highlight is not accepted as the requested story", async (t) => {
  fastWaits(t);
  mockPage({ user }, { ok: true, reels: [makeReel(5, "highlight:900")] });
  t.mock.method(globalThis, "fetch", async () =>
    response({ reels: { other: { ...makeReel(3, "99"), user: { id: "99", username: "someoneelse" } } } }));
  await assert.rejects(resolveStoryPlan(storyUrl, parseInstagramUrl(storyUrl), 1),
    (error) => error.code === "story_unavailable");
});

test("persistent lookup failures explain loading trouble, not deleted content", async (t) => {
  fastWaits(t);
  const url = "https://www.instagram.com/stories/example/";
  t.mock.method(globalThis, "fetch", async () => response({}, 404));
  await assert.rejects(resolveStoryPlan(url, parseInstagramUrl(url)), (error) => {
    assert.equal(error.code, "story_load_failed");
    assert.equal(error.context.status, 404);
    assert.match(error.context.endpoint, /web_profile_info/);
    assert.ok(error.context.diagnostics.length);
    return true;
  });
});

function mockInjectedQuery(t, body, status = 200, operationKind = "query") {
  globalThis.location = { hostname: "www.instagram.com" };
  globalThis.document = { cookie: "other=1; csrftoken=test-csrf" };
  globalThis.window = {
    require: (name) => name === "getAsyncParams"
      ? () => ({ fb_dtsg: "test-session-parameter", lsd: "test-lsd" })
      : {
        params: {
          id: "live-document-id",
          name: name.replace(".graphql", ""),
          operationKind,
          providedVariables: { featureFlag: { get: () => true } }
        }
      }
  };
  globalThis.chrome = {
    scripting: { executeScript: async ({ func, args }) => [{ result: await func(...args) }] }
  };
  return t.mock.method(globalThis, "fetch", async () => new Response(body, {
    status, headers: { "Content-Type": "text/javascript", "retry-after": "45" }
  }));
}

test("the injected query uses current document IDs, session headers and protected JSON", async (t) => {
  const fetch = mockInjectedQuery(t, `for (;;);${JSON.stringify({
    data: { xdt_api__v1__feed__reels_media__connection: { edges: [{ node: makeReel(17, "highlight:900") }] } }
  })}`);
  const reels = await fetchStoryPageReels(1, parseInstagramUrl(highlightUrl));
  assert.equal(reels[0].items.length, 17);
  const [url, options] = fetch.mock.calls[0].arguments;
  assert.equal(url, "/graphql/query");
  assert.equal(options.method, "POST");
  assert.equal(options.credentials, "include");
  assert.equal(options.headers["X-CSRFToken"], "test-csrf");
  assert.equal(options.headers["X-FB-LSD"], "test-lsd");
  assert.equal(options.body.get("doc_id"), "live-document-id");
  assert.deepEqual(JSON.parse(options.body.get("variables")), {
    initial_reel_id: "highlight:900", reel_ids: ["highlight:900"], first: 1, featureFlag: true
  });
  assert.doesNotMatch(JSON.stringify(reels), /test-csrf|test-session-parameter|test-lsd/);
});

test("standalone story queries use the owner ID and the reels_media response shape", async (t) => {
  const fetch = mockInjectedQuery(t, JSON.stringify({
    data: { xdt_api__v1__feed__reels_media: { reels_media: [makeReel()] } }
  }));
  const reels = await fetchStoryPageReels(1, parseInstagramUrl(storyUrl), "42");
  assert.equal(reels[0].items.length, 10);
  assert.deepEqual(JSON.parse(fetch.mock.calls[0].arguments[1].body.get("variables")), {
    reel_ids_arr: ["42"], featureFlag: true
  });
});

test("query errors never produce partial success or expose session data", async (t) => {
  mockInjectedQuery(t, JSON.stringify({ errors: [{ message: "test-session-parameter" }], data: null }));
  await assert.rejects(fetchStoryPageReels(1, parseInstagramUrl(highlightUrl)), (error) => {
    assert.equal(error.code, "story_query_failed");
    assert.doesNotMatch(JSON.stringify(error), /test-session-parameter/);
    return true;
  });
});

test("HTML responses are reported as unreadable instead of a successful empty reel", async (t) => {
  mockInjectedQuery(t, "<!DOCTYPE html><title>Instagram</title>");
  await assert.rejects(fetchStoryPageReels(1, parseInstagramUrl(highlightUrl)),
    (error) => error.code === "invalid_response");
});

test("a hung page request is aborted and reported as a timeout", async (t) => {
  mockInjectedQuery(t, "{}");
  const setTimer = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, delay) => {
    assert.equal(delay, 12000);
    return setTimer(callback, 0);
  });
  t.mock.method(globalThis, "fetch", (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }));
  await assert.rejects(fetchStoryPageReels(1, parseInstagramUrl(highlightUrl)),
    (error) => error.code === "timeout");
});

test("an unloaded or non-query document cannot issue a request", async (t) => {
  const fetch = mockInjectedQuery(t, "{}", 200, "mutation");
  await assert.rejects(fetchStoryPageReels(1, parseInstagramUrl(highlightUrl)),
    (error) => error.code === "story_page_not_ready");
  assert.equal(fetch.mock.calls.length, 0);
});

test("the injected query preserves HTTP status and retry-after without returning response bodies", async (t) => {
  mockInjectedQuery(t, "test-session-parameter", 429);
  await assert.rejects(fetchStoryPageReels(1, parseInstagramUrl(highlightUrl)), (error) => {
    assert.equal(error.code, "http_429");
    assert.equal(error.context.status, 429);
    assert.equal(error.context.retryAfterSeconds, 45);
    assert.doesNotMatch(JSON.stringify(error), /test-session-parameter/);
    return true;
  });
});
