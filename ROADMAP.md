# Implementation Roadmap

## Goals

- Keep extraction API-first and URL-driven.
- Avoid DOM scraping as a primary resolver.
- Fail clearly when Instagram blocks, rate-limits, or hides content.
- Improve UX without mixing extraction logic into the content script.

## Completed In This Pass

### Phase 0: Cleanup And Core Architecture

- Removed DOM-based extraction as a core path.
- Reduced the content script to confirmation and toast UI.
- Centralized page resolution in the background service worker.
- Standardized errors and settings handling.

### Phase 1: API-First Media Resolution

- Added post and reel resolution via shortcode to media info and GraphQL endpoints.
- Added story and highlight resolution through Instagram reels APIs.
- Normalized media items into a single download plan format.

### Phase 2: User-Facing Download Controls

- Added an options page for confirmation, metadata export, and filename templates.
- Added metadata sidecar JSON export.
- Simplified the context menu to one page-level action.

### Phase 3: UX And Diagnostics

- Added a popup with explicit download, refresh, settings, and copy-URL actions.
- Added current-page diagnostics showing counts, page kind, and resolver source.
- Added clearer reason-code based error messages for unsupported, unavailable, login, and rate-limited failures.

### Phase 4: Bounded Batch Workflows

- Added profile-page batch downloads using Instagram profile APIs plus per-post resolution.
- Added duplicate suppression backed by local extension storage.
- Added lightweight download history surfaced in the popup.

## Next Phases

### Phase 5: Metadata Depth

- Expanded sidecar export with richer page context and per-item identifiers.
- Added optional current-post comment export only when available through stable APIs.
- Added collision-safe filename planning for media and metadata within each batch.
- Added an optional metadata subfolder for users who want less visible folder clutter.

### Phase 6: Profile Scope And Export Controls

- Added a simpler popup summary with collapsible detail sections.
- Added optional easy-click mode that replaces the popup with direct downloads.
- Added green/red availability badges for easy mode based on whether the current Instagram page resolves.
- Added clearer profile pagination diagnostics when Instagram stops returning more pages.
- Added optional export of history and batch reports.

### Phase 7: Batch Usability

- Added finer duplicate controls and resettable download history.
- Added selective profile download modes such as images-only or videos-only.
- Added progress reporting when many profile posts are being resolved.

### Phase 8: Resumable Full Profile Crawl

- Added checkpointed full profile crawl jobs backed by extension storage.
- Added start, resume, and reset controls for full profile crawls on profile pages.
- Added saved-cursor batch processing so large profiles can be continued across separate runs.
- Added popup visibility into crawl progress, last batch results, and crawl completion state.

## Non-Goals

- Hashtag crawling.
- Live recording.
- DASH or HLS assembly.
- Any bypass of Instagram permissions or privacy restrictions.
