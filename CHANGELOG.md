# Changelog

All notable changes to Lectio Sync are documented here.

## [Unreleased]

### Fixed

- Automatically recreate the dedicated calendar and resume synchronization when a user deletes it in Google Calendar or Apple Calendar.

### Added

- Firefox desktop build with Google installed-app OAuth, PKCE, CSRF state validation, refresh, and revocation.
- Firefox release packaging and browser-specific test guidance.
- Open-source license, contribution guide, continuous integration, and publication checklist.

### Changed

- Desktop support is now documented explicitly by browser and authentication capability.
- Build verification now covers Chrome, Firefox, and Safari artifacts.
- Safari now creates its dedicated calendar in iCloud so it syncs across Apple devices, and never falls back to a device-local calendar.

## [0.1.9] - 2026-08-07

- Initial Chrome and Safari implementation.
