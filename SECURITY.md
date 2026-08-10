# Security design

Lectio Sync handles school timetable data and sits next to two valuable authenticated sessions. Its main security rule is that session material never leaves the browser or operating-system credential store.

## Trust boundaries

### Lectio

- The extension requests only `https://www.lectio.dk/*`.
- It has no `cookies`, `webRequest`, or broad browsing-history permission.
- Lectio session cookies are attached by the browser directly to Lectio requests through `credentials: include`; extension code never reads or stores cookie values.
- MitID is used only on the real Lectio page. Lectio Sync never renders a MitID form, observes credentials, captures authentication codes, or attempts to automate reauthentication.
- Timetable HTML is parsed in memory and discarded. A fetch/redirect/auth/parser error terminates the sync before the calendar adapter is called.

### Chrome, Brave, Firefox, and Google Calendar

- Chrome and Brave OAuth tokens are obtained through `chrome.identity` and are not written to extension storage.
- Firefox uses Google's installed-app authorization-code flow with PKCE, an unpredictable CSRF `state`, and Firefox's browser-managed loopback callback. Its refresh token is stored in local extension storage; its access token is kept only in memory.
- Firefox disconnect removes the refresh token locally before making a best-effort Google revocation request.
- The only Google scope is `https://www.googleapis.com/auth/calendar.app.created`.
- Events are written to a calendar created specifically for Lectio Sync.
- Ownership metadata is stored in Google Calendar private extended properties. The adapter lists and reconciles only events carrying the Lectio Sync marker.
- No OAuth client secret or signing key may be committed. The security test scans the repository, and release packaging refuses a placeholder client ID.

### Safari and Apple Calendar

- JavaScript communicates with the containing Safari app through native messaging.
- EventKit requires full calendar permission because reliable reconciliation must read, update, and delete previously created events. The operating-system permission is broader than the data the code uses.
- The native handler restricts operations to the selected Google-backed `Lectio` calendar and to events carrying a private `lectiosync://event` ownership marker.
- Delete requests are rejected if the event is outside that calendar or lacks the ownership marker.
- The macOS extension is sandboxed and has only the calendar personal-information entitlement.

## Data integrity controls

- Every fetched Lectio page must parse successfully before any calendar read/write phase begins.
- Stable event IDs make inserts idempotent.
- Existing provider event IDs are carried explicitly into updates, avoiding Safari duplicates.
- Missing events are deleted only after two consecutive valid observations.
- On all uncertain states the UI says “Sync paused safely” and reports that the calendar was not changed.
- Cancellation removal is opt-in; the default keeps the event, prefixes it as cancelled, and marks the time free.

## Least privilege

Chrome and Brave permissions: `alarms`, `identity`, `notifications`, and `storage`; hosts are Lectio and the Google APIs host.

Firefox uses the same permissions and adds only Google's OAuth token host. The Google authorization page is opened by Firefox's Identity API, not injected into a Lectio or extension page.

Safari permissions: `alarms`, `storage`, and `nativeMessaging`; the only web host is Lectio. Google Calendar access happens through the OS calendar account rather than a web token.

Extension pages use a restrictive Content Security Policy with scripts from self only, objects disabled, base URLs disabled, and framing disabled. Bundles contain no remotely hosted code.

## Known limits

- Lectio has no supported public student timetable API in this implementation. A Lectio HTML redesign may pause sync until the parser is updated.
- Browser scheduling is best-effort and does not run when the relevant browser/extension process is unavailable.
- A malicious browser or OS account with local code execution is outside this extension's threat model.
- Event titles, rooms, teacher names, and optional homework become visible to the selected calendar provider because that is the product's requested output.

## Release checklist

1. Run `npm ci` and confirm the dependency audit has no known vulnerabilities.
2. Run `npm run verify` and `npm run verify:safari` on the release commit.
3. Complete the live-account cases in `docs/MANUAL_TEST_PLAN.md` with dedicated test accounts.
4. Verify Chrome, Firefox, and Safari store permission disclosures match `PRIVACY.md`.
5. Confirm the Chrome OAuth client ID belongs to the exact published Chrome extension ID and the Firefox add-on ID is stable.
6. Inspect both ZIPs and the signed Safari archive; do not publish source maps, keys, provisioning profiles, or test credentials.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or include student data in a report. Use GitHub's private vulnerability-reporting feature for the public repository. Include the affected version, browser, impact, reproduction steps using synthetic data, and a suggested remediation if available.

The maintainer should acknowledge a report within seven days, keep the reporter updated while validating it, and publish a coordinated fix and advisory when appropriate.
