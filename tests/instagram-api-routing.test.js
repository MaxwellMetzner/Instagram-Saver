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
