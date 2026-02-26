# Instagram Saver

A minimal browser extension to save images and videos from Instagram posts to your local machine.

## Purpose

This extension helps you quickly download media (images & videos) served in Instagram posts and stories when browsing Instagram in a Chromium-based browser.

## Features

- Download images and videos from individual Instagram posts.
- Lightweight: single-file extension scripts (no build step required).

## Installation (Local / Developer)

1. Open Chrome (or Edge/Brave) and go to `chrome://extensions/`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this repository folder (the folder containing `manifest.json`, `content.js`, `background.js`).
4. The extension should appear in your toolbar; pin it if desired.

## Usage

1. Open Instagram and navigate to the post containing the media you want to save.
2. Use the extension icon (or the extension-provided UI) to download the visible image or video.
3. Files will be saved via the browser's download mechanism (check your browser's Downloads folder).

Note: Exact UI/controls depend on the extension's scripts (`content.js` / `background.js`). If the extension adds a context menu or inline controls, use those as indicated.

## Permissions

This extension requires the following permissions to function:

- **activeTab**: Allows the extension to access the active tab to detect Instagram content.
- **contextMenus**: Enables context menu options for downloading media.
- **downloads**: Enables the ability to download images and videos from Instagram.
- **scripting**: Permits the extension to inject and execute scripts on Instagram pages.
- **tabs**: Allows the extension to interact with browser tabs.
- **webRequest**: Permits monitoring and filtering of web requests.

## Privacy

All operations are performed locally within your browser. The extension does not require communication with external servers or transmit any data unless explicitly coded to do so. Review the source code if you have privacy concerns.

- Review `manifest.json` to see requested permissions (for example: `activeTab`, `downloads`, `scripting`).
- This extension operates locally in your browser. No external servers are required unless the code explicitly contacts one — review the source if you have privacy concerns.

## Development

- No build step required for most changes; update the JS files and reload the unpacked extension in `chrome://extensions`.
- For troubleshooting, open DevTools on Instagram pages and check the console for any errors from `content.js`.

## Troubleshooting

- If downloads fail, ensure the extension has the `downloads` permission in `manifest.json`.
- If Instagram changes its markup, `content.js` selectors may need updates.

## License

Use and modify this extension as you like. Add a license file to the repository if you want an explicit license.

---
File list: manifest.json, background.js, content.js, icons/.
