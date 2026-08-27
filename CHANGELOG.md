# Changelog

All notable changes to Lectio Sync are documented here.

## [0.2.4] - 2026-08-27

### Fixed

- Automatically recreate the dedicated calendar and resume synchronization when Google reports it as missing or deleted.
- Invalidate old full-horizon coverage when a calendar is connected or recreated so the replacement calendar is completely repopulated.
- Keep saved settings unchanged when a calendar colour update fails.

### Added

- Firefox desktop build with Google installed-app OAuth, PKCE, CSRF state validation, refresh, and revocation.
- Firefox release packaging and browser-specific build guidance.

### Changed

- Desktop support is now documented explicitly by browser and authentication capability.
- Build verification now covers Chrome, Firefox, and Safari artifacts.
- Setup and store copy now clearly explain that Apple Calendar requires the same Google account on each device and that this version does not create an iCloud calendar.

## [0.1.9] - 2026-08-07

- Initial Chrome and Safari implementation.
