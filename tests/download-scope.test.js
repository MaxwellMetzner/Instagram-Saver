import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { getMediaMatchKey } from "../src/background/instagram/media.js";
import { getCanonicalPageUrl, parseInstagramUrl } from "../src/background/instagram/urls.js";
import {
  currentItemUnknownError,
  locateCurrentItem,
  matchVisibleMedia,
  selectCurrentItem,
  supportsCurrentItem
} from "../src/background/plans/selection.js";

const CDN = "https://scontent-lga3-1.cdninstagram.com/v/t51.2885-15";

function makeItems(count) {
  return Array.from({ length: count }, (_, index) => ({
    type: index === 1 ? "video" : "image",
    url: `${CDN}/slide${index}_abcdef_n.jpg?stp=dst-jpg&_nc_ht=x`,
    mediaId: `${1000 + index}_42`,
    matchKeys: [`slide${index}_abcdef_n.jpg`, `slide${index}_abcdef_s640.jpg`]
  }));
}

function mockVisibleMedia(visibleMedia) {
  globalThis.chrome = {
    scripting: {
      executeScript: async () => [{ result: visibleMedia }]
    }
  };
}

afterEach(() => {
  delete globalThis.chrome;
});

describe("URL focus hints", () => {
  test("carousel ?img_index is converted to a zero-based slide index", () => {
    assert.deepEqual(parseInstagramUrl("https://www.instagram.com/p/C8xYz12AbCd/?img_index=3"), {
      kind: "post",
      subtype: "post",
      shortcode: "C8xYz12AbCd",
      focusIndex: 2
    });
    assert.equal(parseInstagramUrl("https://www.instagram.com/p/C8xYz12AbCd/").focusIndex, null);
    assert.equal(parseInstagramUrl("https://www.instagram.com/p/C8xYz12AbCd/?img_index=0").focusIndex, null);
    assert.equal(parseInstagramUrl("https://www.instagram.com/reel/C8xYz12AbCd/").subtype, "reel");
  });

  test("story and highlight URLs expose the visible frame id", () => {
    assert.deepEqual(parseInstagramUrl("https://www.instagram.com/stories/natgeo/3456789/"), {
      kind: "story",
      username: "natgeo",
      storyPk: "3456789",
      focusPk: "3456789"
    });
    assert.equal(
      parseInstagramUrl("https://www.instagram.com/stories/natgeo/?story_media_id=789_123").focusPk,
      "789"
    );
    assert.equal(parseInstagramUrl("https://www.instagram.com/stories/highlights/1799/").focusPk, null);
    assert.equal(
      parseInstagramUrl("https://www.instagram.com/stories/highlights/1799/?story_media_id=555_1").focusPk,
      "555"
    );
  });

  test("canonical page URLs drop query strings and hashes", () => {
    assert.equal(
      getCanonicalPageUrl("https://www.instagram.com/p/C8xYz12AbCd/?img_index=2#comments"),
      "https://www.instagram.com/p/C8xYz12AbCd/"
    );
    assert.equal(getCanonicalPageUrl("not a url"), "not a url");
  });
});

describe("media match keys", () => {
  test("use the CDN file name so different sizes of the same media match", () => {
    assert.equal(
      getMediaMatchKey(`${CDN}/12345_ABCdef_n.jpg?stp=dst-jpg_e35&_nc_ht=scontent`),
      "12345_abcdef_n.jpg"
    );
    assert.equal(getMediaMatchKey("https://example.com/a.js"), null);
    assert.equal(getMediaMatchKey(""), null);
    assert.equal(getMediaMatchKey(null), null);
  });

  test("matchVisibleMedia picks the first (largest) element that matches an item", () => {
    const items = makeItems(3);
    const visible = [
      { tag: "img", area: 200000, urls: [`${CDN}/unrelated_profile_pic.jpg`] },
      { tag: "img", area: 150000, urls: [`${CDN}/slide2_abcdef_s640.jpg?x=1`] },
      { tag: "img", area: 9000, urls: [`${CDN}/slide0_abcdef_n.jpg`] }
    ];
    assert.equal(matchVisibleMedia(items, visible), 2);
    assert.equal(matchVisibleMedia(items, []), -1);
    assert.equal(matchVisibleMedia([{ url: "x" }], visible), -1);
  });
});

describe("locating the item on screen", () => {
  test("only posts, stories, and highlights support current-item downloads", () => {
    assert.equal(supportsCurrentItem("post"), true);
    assert.equal(supportsCurrentItem("story"), true);
    assert.equal(supportsCurrentItem("highlight"), true);
    assert.equal(supportsCurrentItem("profile"), false);
    assert.equal(supportsCurrentItem("saved"), false);
  });

  test("single-item pages need no detection", async () => {
    assert.deepEqual(await locateCurrentItem({ kind: "post" }, makeItems(1)), { index: 0, method: "single" });
  });

  test("story frames are matched from the URL before looking at the page", async () => {
    let probed = false;
    globalThis.chrome = { scripting: { executeScript: async () => { probed = true; return []; } } };
    const location = await locateCurrentItem({ kind: "story", focusPk: "1002" }, makeItems(3), 7);
    assert.deepEqual(location, { index: 2, method: "url" });
    assert.equal(probed, false);
  });

  test("the visible media on screen wins over the post URL hint", async () => {
    mockVisibleMedia([{ tag: "img", area: 300000, urls: [`${CDN}/slide1_abcdef_n.jpg`] }]);
    const location = await locateCurrentItem({ kind: "post", focusIndex: 0 }, makeItems(3), 7);
    assert.deepEqual(location, { index: 1, method: "screen" });
  });

  test("posts fall back to ?img_index, then to the first slide", async () => {
    assert.deepEqual(await locateCurrentItem({ kind: "post", focusIndex: 2 }, makeItems(3)), { index: 2, method: "url" });
    assert.deepEqual(await locateCurrentItem({ kind: "post", focusIndex: 9 }, makeItems(3)), { index: 0, method: "assumed" });
    assert.deepEqual(await locateCurrentItem({ kind: "post", focusIndex: null }, makeItems(3)), { index: 0, method: "assumed" });
  });

  test("stories without a URL or screen match are reported as unknown", async () => {
    mockVisibleMedia([]);
    assert.equal(await locateCurrentItem({ kind: "story", focusPk: null }, makeItems(3), 7), null);
    assert.equal(await locateCurrentItem({ kind: "highlight", focusPk: "999" }, makeItems(3)), null);
    assert.equal(await locateCurrentItem({ kind: "profile" }, makeItems(3)), null);
    assert.equal(await locateCurrentItem({ kind: "post" }, []), null);

    const error = currentItemUnknownError({ kind: "highlight" });
    assert.equal(error.code, "current_item_unknown");
    assert.match(error.message, /highlight frame/);
  });

  test("a failing page probe falls back instead of throwing", async () => {
    globalThis.chrome = { scripting: { executeScript: async () => { throw new Error("Cannot access contents"); } } };
    const location = await locateCurrentItem({ kind: "post", focusIndex: 1 }, makeItems(3), 7);
    assert.deepEqual(location, { index: 1, method: "url" });
  });

  test("selectCurrentItem keeps one item but remembers its original position", () => {
    const plan = { items: makeItems(4), meta: { id: "abc", pageKind: "post" } };
    const selected = selectCurrentItem(plan, { index: 2, method: "screen" });

    assert.equal(selected.items.length, 1);
    assert.equal(selected.items[0].mediaId, "1002_42");
    assert.equal(selected.items[0].selectionIndex, 2);
    assert.equal(selected.meta.downloadScope, "current");
    assert.deepEqual(selected.meta.currentItem, { position: 3, total: 4, method: "screen" });
    assert.equal(plan.items.length, 4, "the original plan is not mutated");
  });
});
