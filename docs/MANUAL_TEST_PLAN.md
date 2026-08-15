# Manual release test plan

Automated tests use synthetic Lectio pages and mocked calendar providers. Complete these cases with dedicated non-production test accounts before a store release.

## Recording results

Record each completed case in `MANUAL_TEST_RESULTS.md` using `PASS`, `FAIL`, or `NOT RUN`. For failures, include the browser/version, short reproduction, expected versus actual behavior, and any safe diagnostic reference (never account data, tokens, or screenshots containing student data).

Copy this block for each browser while testing:

```text
### <Browser> — <version> — <date>

- [ ] 1 — <short result> — PASS | FAIL | NOT RUN
- [ ] 2 — <short result> — PASS | FAIL | NOT RUN
- [ ] 3 — <short result> — PASS | FAIL | NOT RUN
- [ ] 4 — <short result> — PASS | FAIL | NOT RUN
- [ ] 5 — <short result> — PASS | FAIL | NOT RUN
- [ ] 6 — <short result> — PASS | FAIL | NOT RUN
- [ ] 7 — <short result> — PASS | FAIL | NOT RUN
- [ ] 8 — <short result> — PASS | FAIL | NOT RUN
- [ ] 9 — <short result> — PASS | FAIL | NOT RUN
- [ ] 10 — <short result> — PASS | FAIL | NOT RUN
```

Use only the applicable numbered rows; Brave reuses Chrome cases, Firefox has six cases, and Safari has five. Preserve earlier smoke-test evidence in the results file—add a new dated section rather than replacing it.

## Chrome

1. Install the unpacked release build and confirm the permission list contains only Lectio, Google APIs, identity, alarms, notifications, and storage.
2. Start setup, complete a real Lectio/MitID login on `lectio.dk`, and confirm the extension never presents or captures the MitID UI itself.
3. Connect a test Google account and verify a new `Lectio` calendar is created.
4. Run an initial sync and compare at least two weeks against Lectio: title, date, Copenhagen time, room, teacher, and link.
5. Change a test module's time/room and verify the existing event updates without duplication.
6. Cancel a module and verify the default event is prefixed `AFLYST ·`, red, and free. Verify one desktop notification appears and opens Google Calendar when clicked.
7. Enable homework, verify it appears, then disable it and verify it is removed at the next update.
8. Sign out of Lectio and verify the next check pauses without changing any Google event.
9. Reauthenticate and verify sync recovers.
10. Revoke Google access and verify the UI requests reconnection without changing snapshots.

## Brave

1. Repeat the Chrome cases using the exact Chrome release ZIP.
2. Verify setup behavior with Brave's Google-login-for-extensions setting disabled and enabled, and document the user-facing recovery instruction.
3. Confirm Brave Shields do not prevent Lectio or Google Calendar requests under default settings.

## Firefox

1. Install a signed test build with the stable Firefox add-on ID and a dedicated Google Desktop OAuth client.
2. Confirm the OAuth request uses the `calendar.app.created` scope and Firefox's loopback callback.
3. Complete setup and the Chrome synchronization, cancellation, expiry, and recovery cases.
4. Restart Firefox and verify a scheduled or manual sync refreshes authorization without an interactive prompt.
5. Disconnect Google, confirm the local refresh token is removed, and verify a later sync requires explicit reconnection.
6. Tamper with the OAuth callback state in a development test and verify token exchange is rejected.

## Safari on macOS

1. Build/sign the generated Xcode project, enable the extension, and grant only the requested Safari host and Calendar permissions.
2. Verify the native bridge finds the Google account configured in Internet Accounts and creates/uses its `Lectio` calendar.
3. Repeat the initial, update, cancellation, expiry, and recovery cases above.
4. Attempt to pass the native bridge an event without a Lectio ownership marker in a debug test and verify deletion is rejected.
5. Quit/reopen Safari and verify the extension resumes safely.

## Negative parser fixtures

Capture sanitized HTML structures—not student data—when Lectio changes. Add a regression fixture and parser test before changing the parser. Never commit names, IDs, homework, messages, cookies, CSRF values, or authentication pages from a real student account.
