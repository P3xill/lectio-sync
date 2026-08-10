# Publication guide

This guide separates reproducible repository work from steps that require the maintainer's store, Google Cloud, Apple, and GitHub accounts.

## Release support boundary

| Target | Browsers | Calendar authentication |
| --- | --- | --- |
| Chrome package | Google Chrome and Brave | Chrome Identity API; Brave may require its Google-login-for-extensions setting |
| Firefox package | Mozilla Firefox | Google Desktop OAuth client with PKCE and Firefox's loopback callback |
| Safari app | Safari on macOS | Apple EventKit and the Google account configured in macOS |

Edge, Opera, and Vivaldi can often load Chromium extension code, but Lectio Sync does not claim support because they do not provide Chrome's Google token service consistently. A secure release for those browsers requires a separately reviewed native helper or hosted OAuth component.

## One-time project setup

1. Create a public GitHub repository and push the source without `dist`, `artifacts`, `.build`, `.env`, signing files, or credentials.
2. Enable GitHub private vulnerability reporting and branch protection for `main`.
3. Publish a project homepage containing the product description and links to `PRIVACY.md`, `SECURITY.md`, and the license.
4. Create a Google Cloud project, enable the Google Calendar API, configure the OAuth consent screen, and use the narrow `calendar.app.created` scope.
5. Create a Chrome Extension OAuth client after the Chrome Web Store assigns the extension ID.
6. Create a Desktop OAuth client for Firefox. Do not bundle a client secret; the Firefox flow uses PKCE and treats the extension as a public installed client.
7. Complete Google's production OAuth verification if Google requires it for the selected scope and audience.

## Build release artifacts

Use a clean checkout and Node.js 20 or later:

```sh
npm ci
npm audit --omit=dev
npm run verify
GOOGLE_OAUTH_CLIENT_ID="chrome-client.apps.googleusercontent.com" npm run package:chrome
GOOGLE_FIREFOX_OAUTH_CLIENT_ID="desktop-client.apps.googleusercontent.com" npm run package:firefox
```

This produces `artifacts/lectio-sync-chrome.zip` and `artifacts/lectio-sync-firefox.zip`. Source maps, SVG source artwork, credentials, and platform signing files are excluded from release ZIPs.

For Safari:

```sh
npm run convert:safari
npm run verify:safari
open "Safari/Lectio Sync/Lectio Sync.xcodeproj"
```

Select the maintainer's Apple team, use a stable bundle identifier, create an Archive in Xcode, validate it, and submit it through App Store Connect.

## Store submissions

### Chrome Web Store

- Upload the Chrome ZIP.
- Use the single-purpose description in `docs/STORE_LISTING.md`.
- Disclose access to Lectio pages, Google Calendar API, notifications, and local extension storage.
- Link the public privacy policy and project homepage.
- After the item ID exists, confirm the OAuth client is bound to that exact ID and rebuild the final ZIP.

### Firefox Add-ons

- Upload the Firefox ZIP to addons.mozilla.org for signing.
- Keep the manifest add-on ID stable across releases.
- Supply source code and reproducible build instructions if Mozilla requests them.
- Test the signed package because Firefox's OAuth redirect identity depends on the stable add-on ID.

### Mac App Store

- Provide Apple Calendar usage explanations that match the generated `Info.plist` values.
- Explain that the app uses the student's existing Google account through EventKit and does not receive their Google password.
- Complete App Privacy answers using `PRIVACY.md` as the source of truth.

## Release gate

Do not publish until all automated checks, the Codex Security report, and every applicable live-account case in `docs/MANUAL_TEST_PLAN.md` pass. Confirm each store's current policies immediately before submission because store requirements can change.
