# Manual release test results

Test date: 2026-08-10
Release candidate: 0.2.0

These are smoke-test results for the current local release artifacts. Account-dependent cases in `MANUAL_TEST_PLAN.md` still require dedicated non-production Lectio and Google accounts.

## Brave

- PASS — Loaded the unpacked Chrome build from `dist/chrome` (version 0.2.0).
- PASS — The displayed permissions were notifications plus access to Lectio and Google APIs.
- PASS — File URL access and private-window access were disabled.
- PASS — The first-run popup and settings page rendered correctly.
- PASS — The settings page scrolled through the homework option, save button, and privacy footer.
- PASS — The public Lectio school list loaded with Brave Shields enabled under the default settings.
- NOT RUN — Google connection, real timetable synchronization, cancellation, notification, expiry, and recovery cases require dedicated test accounts.

## Firefox

- PASS — Loaded `artifacts/lectio-sync-firefox.zip` as a temporary extension in Firefox 153.0.3.
- PASS — Firefox reported the stable extension ID `lectio-sync@lectiosync.dk` and a running background script.
- PASS — The first-run popup and settings page rendered correctly.
- PASS — The settings page scrolled through the homework option, save button, and privacy footer.
- PASS — The public Lectio school list loaded correctly.
- NOT RUN — Signed-package persistence, OAuth, real synchronization, restart, disconnect, and callback-state cases require an AMO-signed build, a dedicated Google Desktop OAuth client, and test accounts.

## Safari on macOS

- PASS — The generated Xcode project compiled without signing.
- PASS — A locally signed 0.2.0 app and extension built successfully with Apple development team `3ZUR2HBZH4`.
- PASS — Code signing verification succeeded for both the app and extension.
- PASS — Safari displayed and enabled Lectio Sync 0.2.0.
- PASS — The popup rendered and correctly showed the signed-out/expired Lectio state.
- NOT RUN — Full popup scrolling could not be directly exercised through macOS accessibility controls; the same shared popup scroll path passed in Brave and Firefox.
- NOT RUN — EventKit calendar creation and account-dependent synchronization cases require a dedicated macOS Google calendar test account and Lectio test account.

## Chrome

- PASS — The ChatGPT browser-control helper connected to the active Chrome profile.
- PASS — The public Lectio school list loaded correctly in a new controlled Chrome tab.
- PASS — Loaded and enabled Lectio Sync 0.2.0 from `dist/chrome` with extension ID `ahipjdmmhiflgdpdhfakhhdmgocdphlf`.
- PASS — The Chrome popup settings page scrolled through the homework option, save button, and privacy footer.
- NOT RUN — Existing logged-in Lectio and Google Calendar tabs were deliberately left untouched because release testing requires dedicated non-production accounts.

## Release status

The Codex Security audit identified release blockers and the local candidate now includes remediations for:

- fail-closed Lectio schedule and activity parsing;
- bounded Lectio response sizes, document complexity, event counts, operation counts, and calendar fields;
- exact-origin, same-school account discovery and runtime message validation;
- Safari EventKit failed-batch rollback and native calendar ownership enforcement;
- accurate UI warnings when a sequential Google update may have partially completed.

The full TypeScript test, coverage, browser-build, and unsigned Safari Xcode verification suites pass after these changes. The formal post-fix Codex Security diff scan could not start because the scanner rejected the repository path, whose directory name ends in a space.

Do not publish the store builds yet. Browser rendering and public Lectio access smoke tests pass, but the account-dependent release cases, signed Firefox persistence/OAuth cases, and formal post-fix security rescan remain outstanding.
