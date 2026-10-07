# Google Calendar 401 recovery — 0.3.1

The user's screenshots show `GOOGLE_AUTH_REQUIRED` and Calendar API `401 Invalid Credentials`. The code cleared the rejected token but immediately stopped the request instead of obtaining a replacement and retrying. This is a confirmed recovery defect. The screenshots alone do not establish why this user's token was rejected or whether her OAuth project is still in Testing.

The adapter now invalidates rejected access tokens and retries the same request once using the browser's OAuth flow. Background requests remain non-interactive. Requests on the same adapter that receive concurrent or late 401 responses share renewal. Auth recovery has an independent budget from rate-limit backoff. Brave's local token cache is cleared independently of Chromium's cache APIs, including when those APIs are unavailable or unsupported. A second 401 stops with reconnection instructions; Google's response is retained in technical details, including persisted sync errors. The details screen reconnects Google rather than repeating a silent sync.

Existing calendar ownership is preserved. Rejected writes retry the identical event body and ID, and successful retries are counted once. No additional OAuth scopes are requested.

Validation: 49 automated tests pass, including 11 new recovery regressions for Chrome, Brave, Firefox, simultaneous and late failures, rejected writes, persistent denial with no writes, and repeat synchronization without duplicates. All three browser bundles build. Chrome and Firefox ZIP integrity checks pass. TypeScript validation uses a temporary copy with dependencies installed from the same package lock because the original dependency directory stalls while reading declaration files.

Release packages are `artifacts/lectio-sync-chrome.zip` and `artifacts/lectio-sync-firefox.zip`, version 0.3.1. They have not been published to browser stores. The Firefox archive requires the usual signing/release process. Chrome must keep its existing store/extension ID, because its OAuth client is bound to that ID; loading the ZIP under a new unpacked-extension ID is not a substitute for an update.

Immediate user recovery: select Reconnect Google Calendar, sign in with the Google account owning the dedicated Lectio calendar, and grant access. After the update, verify sync with the affected account. If Google instead displays an access-blocked/testing/verification screen, inspect the exact installed client's Google Cloud project using the separate README instructions. Live access for this user and current Google Cloud audience status have not been verified.

References:
- https://developers.google.com/workspace/calendar/api/guides/errors
- https://developer.chrome.com/docs/extensions/reference/api/identity
