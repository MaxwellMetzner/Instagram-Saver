# Instagram Saver

An API-first Chrome extension for downloading Instagram media from the current page.

## Current Direction

This project now follows the same general strategy that makes yt-dlp robust on Instagram:

- Resolve content from stable Instagram identifiers in the URL.
- Use authenticated Instagram API responses as the primary source of truth.
- Avoid DOM scraping as a core extraction strategy.
- Keep the content script focused on user-facing UI only.

The extension currently supports:

- Posts and reels via shortcode-based API resolution.
- Stories and highlights via Instagram reels APIs.
- Profile-page batch downloads using Instagram profile APIs and per-post resolution.
- Profile pagination diagnostics and progress reporting during larger profile batches.
- Resumable full profile crawl jobs with saved cursors for large profiles.
- Optional easy-click mode for one-click downloads from the toolbar.
- Metadata sidecar export as JSON.
- Optional batch report JSON export.
- Configurable download naming and folder templates.
- A compact popup with download, refresh, settings, and crawl controls plus collapsible diagnostics.
- Duplicate controls plus local download-history export/reset from the settings page.

## Installation

1. Open `chrome://extensions/` in Chrome or another Chromium-based browser.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this repository folder.

## Usage

1. Open an Instagram post, reel, story, or highlight.
2. Click the extension action to open the popup, inspect the resolved media, and start the download.
3. Confirm the download if confirmation is enabled.

You can also use the page context menu for a direct page-level download.

On profile pages, the popup can also start or resume a full profile crawl. Full crawls are checkpointed in extension storage, so you can continue them later instead of relying on one long-running session.

The extension uses your existing logged-in Instagram browser session. If the content is not visible to your account, the extension cannot download it.

## Settings

The options page lets you configure:

- Theme mode for the extension popup and settings page
- Easy mode for direct left-click downloads with availability badges
- Confirmation before download
- Metadata sidecar export
- Batch report export
- Optional metadata subfolder placement
- Optional current-post comment export in metadata
- Prompting for single-file downloads
- Duplicate handling mode
- Maximum posts to resolve when downloading from a profile page
- Profile media filter for profile-page downloads
- Folder naming template
- Media filename template
- Metadata filename template

It also lets you export or clear the local download history used for duplicate suppression.

## Metadata Export

When enabled, each download operation also writes a JSON sidecar file containing:

- Username and owner identifiers
- Caption and timestamps when available
- Post/story type and extraction source
- Per-item URLs, dimensions, and output filenames

The metadata file is optional. It is useful when you want to:

- Keep provenance for archived downloads
- Reconstruct original source URLs later
- Inspect which API endpoint resolved the media
- Feed the download set into another script or organizer

If you only care about the media files themselves, you can disable sidecar export in the options page.

If batch report export is enabled, the extension also writes a small JSON report describing skipped files, failed files, and profile pagination diagnostics for that run.

Template tokens are available in all three template fields: folder, media filename, and metadata filename. The available tokens are `{username}`, `{id}`, `{kind}`, `{type}`, `{index}`, and `{date}`.

Within a single download batch, the extension now makes planned filenames collision-safe automatically. If two different media items would otherwise resolve to the same relative path, the extension appends a suffix so the files remain distinct. If a file with the same path already exists on disk from an earlier run, Chrome's download system still controls the final on-disk rename behavior.

## Permissions

- `activeTab`: lets the action run against the current Instagram tab.
- `contextMenus`: adds a page-level download menu on Instagram.
- `downloads`: queues file downloads.
- `scripting`: injects the UI content script when needed.
- `storage`: persists extension settings.
- `tabs`: reads the active tab for popup previews and easy-mode availability badges.

## Limitations

- The extension does not bypass Instagram privacy, follow, or login requirements.
- It does not assemble DASH/HLS streams or perform ffmpeg-style muxing.
- Profile downloads and full crawls are still best-effort and depend on Instagram's current API responses, cursors, and rate limits.
- It does not crawl hashtags in the background.

## Development

- Update the source files.
- Reload the unpacked extension in `chrome://extensions`.
- Test against real Instagram pages while logged in.

See `ROADMAP.md` for the implementation plan.
