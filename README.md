# Lectio Sync

- Homepage: https://lectio-sync.johannespeulicke.chatgpt.site
- Privacy: https://lectio-sync.johannespeulicke.chatgpt.site/privacy
- Support: https://lectio-sync.johannespeulicke.chatgpt.site/support

Lectio Sync is an open-source, local-first desktop browser extension that keeps a student's Lectio timetable in a dedicated calendar. It supports Chrome through Chrome Identity, Brave through a browser-managed Web OAuth callback, Firefox through a PKCE-protected installed-app OAuth flow, and Safari through a small EventKit bridge generated as an Xcode app extension.

There is no Lectio password form, no MitID automation, and no hosted backend. The student signs into the real `lectio.dk` website. The extension then reuses that browser session for read-only timetable requests.

## What works

- Detects the student's school and student ID after a normal Lectio login.
- Reads linked normal-lesson activity pages to include their activity title and note while excluding attached-document contents.
- Checks current and upcoming timetable weeks at a user-selected interval from 5 minutes to 24 hours while the browser can run extension alarms.
- Inserts, updates, cancels, and safely removes events in one dedicated calendar.
- Marks cancelled modules `AFLYST · …`, makes them free, and colors them red in Google Calendar.
- Shows a desktop notification as soon as an automatic check detects that a previously synced module was cancelled; clicking it opens Google Calendar.
- Stops before all calendar writes if Lectio returns a login page, an unrecognized page, a redirect, or a network failure.
- Uses two consecutive valid “missing” observations before deleting an event.
- Keeps homework off by default and never stores Lectio HTML, browser cookies, Google passwords, or MitID details. Firefox stores a revocable Google refresh token locally so background synchronization can continue after a browser restart.

## User flow

1. Install the extension and select **Start setup**.
2. Sign into the real Lectio site with MitID.
3. Return to the extension and connect the calendar.
4. Run the first sync. Later checks are automatic while the browser is able to run the extension.

When the Lectio session expires, the extension pauses and asks the student to sign in again. Existing calendar events are left untouched.

### Using Apple Calendar

This version of Lectio Sync stores timetable events in a dedicated **Google Calendar**. It does not create or sync an iCloud calendar.

To see the Lectio calendar in Apple Calendar, add the same Google account to Apple Calendar on every Mac, iPhone, and iPad where it should appear, enable calendar syncing for that account, and make sure the `Lectio` calendar is visible. Using the same Apple Account alone is not sufficient because the calendar belongs to Google, not iCloud.

## Development

Requirements: Node.js 20.12 or later. Safari additionally requires macOS and Xcode.

```sh
npm install
npm run verify
```

`npm run verify` type-checks the source and builds all three release targets.

## Browser support

| Browser | Status | Release package |
| --- | --- | --- |
| Chrome desktop | Supported | Chrome |
| Brave desktop | Supported through a dedicated Web OAuth callback | Chrome |
| Firefox desktop | Supported | Firefox |
| Safari on macOS | Supported | Safari app |
| Edge, Opera, Vivaldi | Not currently supported because Google token APIs differ | None |

The shared WebExtension code is portable, but authentication is not identical across browsers. The project does not claim compatibility based only on whether a package installs.

### Chrome

For a local UI/build check:

```sh
npm run build:chrome
```

Load `dist/chrome` from `chrome://extensions` using **Developer mode → Load unpacked**. Calendar authorization needs two public OAuth clients bound to the same stable extension ID:

1. Create a Google Cloud project and enable the Google Calendar API.
2. Configure its OAuth consent screen.
3. Create a **Chrome Extension** OAuth client using the unpacked extension ID or Chrome Web Store item ID. Chrome uses this client.
4. Create a **Web application** OAuth client whose only authorized redirect URI is `https://EXTENSION_ID.chromiumapp.org/`. Brave uses this browser-owned HTTPS callback because its Chrome Identity token flow is not compatible with Google's extension redirect handling.
5. Build or package with both client IDs:

```sh
GOOGLE_OAUTH_CLIENT_ID="chrome-id.apps.googleusercontent.com" \
GOOGLE_BRAVE_OAUTH_CLIENT_ID="web-id.apps.googleusercontent.com" \
CHROMIUM_OAUTH_MODE="brave" \
npm run build:chrome

GOOGLE_OAUTH_CLIENT_ID="chrome-id.apps.googleusercontent.com" \
GOOGLE_BRAVE_OAUTH_CLIENT_ID="web-id.apps.googleusercontent.com" \
CHROMIUM_OAUTH_MODE="brave" \
npm run package:chrome
```

The release ZIP is written to `artifacts/lectio-sync-chrome.zip`, with `manifest.json` at the archive root. Packaging deliberately fails if either OAuth ID is still a placeholder. Client secrets are neither needed nor allowed in the extension.

The manifest uses Google's narrow `calendar.app.created` scope. Google documents that this permits creating secondary calendars and managing events only on calendars created by the app.

### Firefox

Firefox uses Google's installed desktop application flow with PKCE and Firefox's browser-managed loopback callback. It stores the resulting refresh token only in local extension storage so scheduled synchronization can resume after the background context or browser restarts.

```sh
npm run build:firefox
```

Temporarily load `dist/firefox/manifest.json` from `about:debugging` for UI checks. Live Google authorization requires a Google **Desktop app** OAuth client:

```sh
GOOGLE_FIREFOX_OAUTH_CLIENT_ID="your-id.apps.googleusercontent.com" npm run build:firefox
GOOGLE_FIREFOX_OAUTH_CLIENT_ID="your-id.apps.googleusercontent.com" \
GOOGLE_FIREFOX_OAUTH_CLIENT_SECRET=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tial \
npm run package:firefox
```

The signed add-on must keep the `browser_specific_settings.gecko.id` value stable because Firefox derives its OAuth redirect identity from the add-on ID. The release ZIP is written to `artifacts/lectio-sync-firefox.zip`. Google's issued Desktop client credential is bundled because Google's token endpoint requires it; installed-app client credentials are not confidential, and no private server-side secret is used.

### Safari

Safari cannot use Chrome's `identity` API. Instead, Lectio Sync writes through Apple's EventKit to the Google account already configured in Apple Calendar. The resulting `Lectio` calendar is still a Google calendar, not an iCloud calendar.

```sh
npm run convert:safari
open "Safari/Lectio Sync/Lectio Sync.xcodeproj"
```

In Xcode, select a development team and run the **Lectio Sync (macOS)** scheme. Then enable Lectio Sync in **Safari → Settings → Extensions**. The student must first add a Google account in **System Settings → Internet Accounts** and allow Lectio Sync calendar access.

For repeat local testing after the extension has been signed once, use:

```sh
npm run install:safari-dev
```

This command rebuilds and signs the macOS app, installs it at `~/Applications/Lectio Sync Dev.app`, removes stale development registrations, and launches the host app. Restart Safari normally after installation so it loads the new extension process. If no existing signed build is available for team detection, set `SAFARI_DEVELOPMENT_TEAM` for the first run.

The conversion command is reproducible: it rebuilds the Safari Web Extension, injects the native EventKit handler, adds calendar privacy descriptions and adds the macOS calendar sandbox entitlement. An unsigned compile check is available with:

```sh
npm run verify:safari
```

Public Safari distribution requires Apple signing and the Apple Developer Program.

## Scheduling limitation

Browser alarms are best-effort. They do not wake a shut-down computer and cannot run after the browser/extension process has been terminated. Checks resume when the desktop browser runs again.

Removing that limitation would require an always-on backend. Because an unattended backend cannot safely complete a fresh MitID login for every student, the local browser-extension architecture is the most practical design without asking users to hand over credentials or bypass MitID.

## Project layout

- `src/core/` — parser, safe sync engine, reconciliation, and calendar adapters.
- `src/popup/` — setup, status, settings, and recovery UI.
- `manifests/` — least-privilege Chrome, Firefox, and Safari Manifest V3 templates.
- `safari-native/` — reviewed EventKit bridge copied into the generated Xcode project.

See [SECURITY.md](SECURITY.md) and [PRIVACY.md](PRIVACY.md) before publishing.

## Reference documentation

- [Chrome Extensions OAuth guide](https://developer.chrome.com/docs/extensions/how-to/integrate/oauth)
- [Chrome Identity API](https://developer.chrome.com/docs/extensions/reference/api/identity)
- [Firefox Identity API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/identity)
- [Google OAuth for desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Google Calendar API scopes](https://developers.google.com/workspace/calendar/api/auth)
- [Apple Safari Web Extensions](https://developer.apple.com/documentation/safariservices/safari_web_extensions)
- [Apple EventKit access](https://developer.apple.com/documentation/eventkit/accessing-the-event-store)
