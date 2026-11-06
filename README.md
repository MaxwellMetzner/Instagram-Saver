# Instagram Saver

Instagram Saver is a Chrome extension for downloading media from Instagram pages you can already view in your browser session. It supports posts, reels, stories, highlights, profiles, and your saved posts or saved collections. For stories and profiles, it reads available account and post identifiers from the loaded page before resolving files through Instagram's APIs; saved pages use the authenticated saved-feed APIs.

## What It Does

- **Single downloads** for posts, reels, stories, and highlights: save the whole thing, or only the slide, story, or highlight frame that's on screen right now.
- **Quick downloads** for profiles and saved posts: save the newest posts (24 by default) straight away.
- **Bulk downloads** for profiles and saved posts: go through every post, newest to oldest, in the background. Progress is saved, so you can pause, close the popup, and resume later.
- Uses your logged-in Instagram session, so private or restricted content still follows normal Instagram access rules.
- Skips files you've already downloaded, and can export optional JSON info files and download reports.
- Lets you customize folders, file names, duplicate handling, bulk download speed, and download prompts.

## Installation

1. Open `chrome://extensions/` in Chrome or another Chromium-based browser.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this repository folder.

## Usage

1. Open an Instagram post, reel, story, highlight, profile, or saved posts/collection.
2. Click the extension icon to open the popup.
3. Pick what to download, or right-click the page and choose **Download everything on this page** or **Download only the item on screen**.

### This item only vs. everything

On a carousel post, story, or highlight, the popup offers two buttons:

- **This slide/story/frame only** saves just the item you're looking at. The extension works it out from the page URL (for example `?img_index=3` on carousels or the story id in story links) and from the media visible on screen. If it can't confirm which carousel slide is showing, it says so and falls back to the first slide; for stories and highlights it asks you to try again instead of guessing.
- **All N slides/stories/frames** saves every item.

The **Default download** setting chooses which of the two is highlighted and which one one-click downloads use. A single file keeps its original position in the file name (for example `_03` for the third slide), so it matches a full download.

Stories and highlights are resolved as full lists, including when opened from a profile without reloading Instagram. A story ID in the URL identifies the item on screen; it does not limit the list to that frame. The extension uses Instagram's loaded story queries with your existing session when embedded page data isn't available, with the older API endpoints as fallbacks.

If the full list cannot be loaded, the popup reports the problem instead of presenting one frame as the entire story. Wait for the viewer to load and use **Refresh** to check again. Refresh bypasses cached previews; other previews expire after 15 seconds.

### Quick vs. bulk downloads (profiles and saved posts)

- **Quick download** grabs the newest posts right away, up to the limit set in Settings → Profiles & saved posts.
- **Bulk download** works through the whole profile or saved list in the background, in rounds of 48 posts, with pauses between requests. The popup shows live progress: finding posts, reading posts, saving files, or taking a short break. If Instagram asks the extension to slow down, it cools down and tells you when you can resume. Nothing is downloaded twice.

Bulk progress is kept separately for each profile, for all saved posts, and for each saved collection. **Start over** clears that progress so the next run begins from the newest post.

## Screenshots

The screenshots below show an earlier version of the popup; the layout has since been refreshed.

| Post | Reel | Story |
| --- | --- | --- |
| ![Post download view](screenshots/post.jpg) | ![Reel download view](screenshots/reels.jpg) | ![Story download view](screenshots/story.jpg) |

| Highlight | Profile |
| --- | --- |
| ![Highlight download view](screenshots/highlight.jpg) | ![Profile download view](screenshots/profile.jpg) |

## Settings

Settings save automatically as you change them and are grouped into sections:

- **General**: theme (System, Light, Dark, Instagram), one-click downloads (download straight from the toolbar icon), and skipping files you already have.
- **Posts & stories**: the default download (everything or the item on screen), asking before downloading, and choosing where to save single files.
- **Profiles & saved posts**: how many posts a quick download includes, whether to include photos, videos, or both, and bulk download speed (Gentle, Balanced, Fast).
- **Files & folders**: folder and file name templates with clickable placeholders and a live example.
- **Info files**: optional JSON info files (with comments, in a separate subfolder, or with a custom name) and download reports.
- **History**: recent downloads, export, and clearing. You can also reset all settings to their defaults here.

Available placeholders are `{username}`, `{id}`, `{kind}`, `{type}`, `{index}`, and `{date}`.

Settings from earlier versions (including the old "full crawl" pace and duplicate setting) are migrated automatically, and saved bulk download progress is kept.

## Metadata

When info files are enabled, the extension writes a JSON sidecar file with available details such as username, identifiers, caption text, timestamps, media URLs, dimensions, output filenames, and whether you saved everything or a single item. If download reports are enabled, it also writes a report covering skipped files, failures, and profile pagination diagnostics.

Resolver failures include the endpoint family attempted, HTTP status, timeout information, and bounded fallback diagnostics in the popup. Detailed request events are also logged under the `[InstagramSaver]` prefix in the extension service worker console; response bodies are not written to download reports.

Within a single batch, planned filenames are made collision-safe automatically. If the same path already exists from an earlier run, Chrome still decides the final on-disk rename behavior.

## Permissions

- `contextMenus` to add the right-click download actions
- `downloads` to queue downloads
- `scripting` to inject the content script and to check which media is on screen
- `storage` to persist settings, download history, and bulk download progress
- `tabs` to read the active tab for popup state and availability badges
- Host access is limited to `instagram.com` and its subdomains.
- The toolbar action is disabled on non-Instagram pages.

## Limitations

- The extension does not bypass Instagram login, privacy, or follow restrictions.
- It does not assemble DASH or HLS streams or do ffmpeg-style muxing.
- Quick and bulk downloads are best-effort and depend on Instagram's current APIs, cursors, and rate limits. Saved posts and collections must be accessible to the logged-in account.
- Detecting the item on screen depends on Instagram's page layout; when it can't be detected, the popup tells you before anything is downloaded.
- It does not download hashtag pages.

## Project Structure

```text
manifest.json              Extension manifest (MV3, module service worker)
icons/                     Toolbar and store icons
src/
  background/              Service worker, split into ES modules
    service-worker.js      Entry point: message routing, context menus, tab events
    download-flow.js       Single, quick, and current-item downloads
    core/                  Errors, logging, small utilities
    instagram/             URL parsing, API calls, page data, posts, stories, profiles, saved
    plans/                 Resolving a page into a download plan, current-item selection, summaries
    bulk/                  Bulk download jobs, pacing, and the background runner
    downloads/             File names, info files, and the download queue
    preview/               Popup preview building and caching
    storage/               Download history and duplicate tracking
    ui/                    Toolbar badge, context menus, and the page bridge
  content/content.js       In-page toasts and confirmation prompts
  popup/                   Toolbar popup (view-model.js holds the testable wording logic)
  options/                 Settings page
  shared/                  Settings, labels, message types, and theme shared by every part
tests/                     Node test runner suites
```

## Development

1. Edit the files under `src/`.
2. Run `npm test` (Node 20 or newer, no dependencies to install).
3. Reload the unpacked extension in `chrome://extensions`.
4. Test against real Instagram pages while logged in.
