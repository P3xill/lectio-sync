# Lectio Sync

- Homepage: https://lectio-sync.johannespeulicke.chatgpt.site
- Privacy: https://lectio-sync.johannespeulicke.chatgpt.site/privacy
- Support: https://lectio-sync.johannespeulicke.chatgpt.site/support

Lectio Sync is an open-source, local-first desktop browser extension that keeps a student's Lectio timetable in a dedicated calendar. It supports Chrome through Chrome Identity, Brave through a browser-managed Web OAuth callback, Firefox through a PKCE-protected installed-app OAuth flow, and Safari through a small EventKit bridge generated as an Xcode app extension.

There is no Lectio password form, no MitID automation, and no hosted backend. The student signs into the real `lectio.dk` website. The extension then reuses that browser session for read-only timetable requests.

This extension operates independently of the separate Lectio Sync macOS app. It manages its own calendar connection, settings, and synchronization.

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

`npm run verify` type-checks the source, runs the tests, and builds all three release targets.

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

### Google Calendar reports `401 Invalid Credentials`

This means Calendar rejected the access token. It does not by itself establish that the OAuth project is restricted to test users. Lectio Sync clears the rejected token, obtains a replacement through the current browser's OAuth flow, and retries that request once. Background sync never opens a consent window. Concurrent requests using the same adapter share recovery, and calendar ownership is preserved.

If renewal fails or the replacement is also rejected, select **Reconnect Google Calendar** and grant access again using the Google account that owns the dedicated Lectio calendar. Error details retain Google's response for diagnosis. The details screen also offers reconnection instead of repeating a silent sync. An installed older release needs the updated extension to receive this recovery behavior.

References: [Google Calendar API errors](https://developers.google.com/workspace/calendar/api/guides/errors), [Chrome Identity token cache](https://developer.chrome.com/docs/extensions/reference/api/identity).

### Google blocks sign-in: app has not completed verification

The Google page saying **“Access blocked: Lectio Google calendar integration has not completed the Google verification process”**, with text saying the app is being tested and only developer-approved testers have access, indicates the OAuth project's **Testing** audience restriction. This happens before Google issues an access token; changing the extension's calendar synchronization code cannot lift that restriction. A generic `access_denied` alone does not establish this cause: it can also mean that the user declined permission.

Fix the configuration of the project that owns the OAuth client used by the **installed release**, which may differ from a local `.env`:

1. Identify that release's client: Chrome uses `oauth2.client_id` in its generated `manifest.json`; Brave uses the bundled `GOOGLE_BRAVE_OAUTH_CLIENT_ID`; Firefox uses the bundled `GOOGLE_FIREFOX_OAUTH_CLIENT_ID`. Find the matching client under **Google Auth Platform → Clients** in Google Cloud.
2. For a temporary test, open **Audience → Test users** and add the user's exact Google account. Testing supports at most 100 test users, and Calendar authorizations (including Firefox refresh tokens) expire after seven days. This is a development workaround, not a public release configuration.
3. For public distribution, set the audience to **External** and use **Publish app** to switch to **In production**. In **Data Access**, declare the `https://www.googleapis.com/auth/calendar.app.created` scope actually requested by all three flows. Check **Verification Center** and complete any verification Google requires; publishing and verification are separate steps. Provide the app's accurate branding, support/developer contacts, public homepage and privacy policy, and domain verification where requested. A repository privacy file alone is not a published privacy-policy URL.
4. Check every OAuth project if browser clients belong to different projects. Changing one project's audience does not change another's. A console-only audience change does not require rebuilding the extension; a changed client ID does.
5. Retry with the affected account and a separate Google account that is not a test user after the production/verification requirements are satisfied. Verify that authorization succeeds, the dedicated `Lectio` calendar is created, and a timetable event syncs. Local automated tests cannot confirm Google's live publishing or verification status.

If access remains blocked in production, inspect Google's **error details** and Verification Center. Unapproved sensitive/restricted scopes can trigger an unverified-app warning and user cap; a managed school account can also be restricted by its Workspace administrator. Do not request broader calendar scopes to work around a verification block.

References: [Google app audience and publishing status](https://support.google.com/cloud/answer/15549945?hl=en), [Google verification requirements](https://support.google.com/cloud/answer/13461325?hl=en-GB), [Calendar scope definitions](https://developers.google.com/workspace/calendar/api/auth).

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

See [PRIVACY.md](PRIVACY.md) before publishing.

## Reference documentation

- [Chrome Extensions OAuth guide](https://developer.chrome.com/docs/extensions/how-to/integrate/oauth)
- [Chrome Identity API](https://developer.chrome.com/docs/extensions/reference/api/identity)
- [Firefox Identity API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/identity)
- [Google OAuth for desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Google Calendar API scopes](https://developers.google.com/workspace/calendar/api/auth)
- [Apple Safari Web Extensions](https://developer.apple.com/documentation/safariservices/safari_web_extensions)
- [Apple EventKit access](https://developer.apple.com/documentation/eventkit/accessing-the-event-store)
