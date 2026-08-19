# Manual release test results

Test date: 2026-08-14
Release candidate: 0.2.0

These are smoke-test results for the current local release artifacts. Account-dependent cases in `MANUAL_TEST_PLAN.md` still require dedicated non-production Lectio and Google accounts.

## Account-dependent browser test log

Add new entries here while running the numbered cases in `MANUAL_TEST_PLAN.md`. Keep existing smoke-test results below intact.

### All supported browsers — maintainer verification — 2026-08-14

- [x] Chrome, Brave, Firefox, and Safari installed and their core Lectio Sync workflows worked — PASS (maintainer-reported).
- [x] The detailed initial sync, update/no-duplicate, cancellation, homework removal, expiry/recovery, disconnect, and browser-restart cases in `MANUAL_TEST_PLAN.md` were completed — PASS (maintainer-confirmed 2026-08-15).
- This clears the supported-browser compatibility and account-lifecycle test gates for Chrome, Brave, Firefox, and Safari.

### Safari — 26.5 — 2026-08-14

- [x] Case 3 (initial sync) — Rebuilt extension completed a manual synchronization and reported `Last checked just now` — PASS.
- [x] Case 3 (remaining flows) — Update, cancellation, expiry, and recovery comparisons — PASS (maintainer-confirmed 2026-08-15).
- Diagnostic — The earlier failed attempt returned `Lectio returned an unexpected page.` even though all three initial schedule-week requests had the expected structure. Same-account rediscovery also hid that saved error behind an `Up to date / Never` state; the display/state bug is fixed and covered by a regression test.

```text
### <Browser> — <version> — <date>

- [ ] Case <number> — <short result> — PASS | FAIL | NOT RUN
```

For a failure, add one line with the expected behavior, actual behavior, and safe reproduction notes. Do not include student data, account identifiers, cookies, OAuth codes, or authentication screenshots.

## Brave

- PASS — Loaded the unpacked Chrome build from `dist/chrome` (version 0.2.0).
- PASS — The displayed permissions were notifications plus access to Lectio and Google APIs.
- PASS — File URL access and private-window access were disabled.
- PASS — The first-run popup and settings page rendered correctly.
- PASS — The settings page scrolled through the homework option, save button, and privacy footer.
- PASS — The public Lectio school list loaded with Brave Shields enabled under the default settings.
- PASS — Google connection, real timetable synchronization, cancellation, notification, expiry, recovery, and restart cases completed (maintainer-confirmed 2026-08-15).

## Firefox

- PASS — Loaded `artifacts/lectio-sync-firefox.zip` as a temporary extension in Firefox 153.0.3.
- PASS — Firefox reported the stable extension ID `lectio-sync@lectiosync.dk` and a running background script.
- PASS — The first-run popup and settings page rendered correctly.
- PASS — The settings page scrolled through the homework option, save button, and privacy footer.
- PASS — The public Lectio school list loaded correctly.
- PASS — Signed-package persistence, OAuth, real synchronization, restart, disconnect, and callback-state cases completed (maintainer-confirmed 2026-08-15).

## Safari on macOS

- PASS — The generated Xcode project compiled without signing.
- PASS — A locally signed 0.2.0 app and extension built successfully with Apple development team `3ZUR2HBZH4`.
- PASS — Code signing verification succeeded for both the app and extension.
- PASS — Safari displayed and enabled Lectio Sync 0.2.0.
- PASS — A stable signed development install contained the current bundle, left only one Safari registration, survived a Safari restart, and reopened its popup.
- PASS — The popup rendered and correctly showed the signed-out/expired Lectio state.
- NOT RUN — Full popup scrolling could not be directly exercised through macOS accessibility controls; the same shared popup scroll path passed in Brave and Firefox.
- PASS — EventKit calendar creation and account-dependent synchronization cases completed (maintainer-confirmed 2026-08-15).

## Chrome

- PASS — The ChatGPT browser-control helper connected to the active Chrome profile.
- PASS — The public Lectio school list loaded correctly in a new controlled Chrome tab.
- PASS — Loaded and enabled Lectio Sync 0.2.0 from `dist/chrome` with extension ID `ahipjdmmhiflgdpdhfakhhdmgocdphlf`.
- PASS — The Chrome popup settings page scrolled through the homework option, save button, and privacy footer.
- PASS — Google connection, real synchronization, update/no-duplicate, cancellation, notification, expiry, recovery, and restart cases completed (maintainer-confirmed 2026-08-15).

## Release status

The Codex Security audit identified release blockers and the local candidate now includes remediations for:

- fail-closed Lectio schedule and activity parsing;
- bounded Lectio response sizes, document complexity, event counts, operation counts, and calendar fields;
- exact-origin, same-school account discovery and runtime message validation;
- Safari EventKit failed-batch rollback and native calendar ownership enforcement;
- accurate UI warnings when a sequential Google update may have partially completed.

The full TypeScript test suite passes (166/166), along with the coverage gate, clean Node 20.20.2 CI simulation, Chrome/Firefox/Safari builds, Firefox lint with warnings treated as errors, release ZIP integrity checks using non-production fixture IDs, and unsigned Safari Xcode verification. The formal post-fix Codex Security diff scan could not start because the scanner rejected the repository path, whose directory name ends in a space.

The supported-browser compatibility and detailed account-lifecycle gates now pass based on maintainer testing. Store signing, validation, listing preparation, and submission remain outstanding.
