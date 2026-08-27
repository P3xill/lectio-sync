# Privacy

Lectio Sync has no analytics, advertising, telemetry, crash-reporting service, or application backend.

## Stored locally

- Lectio school ID, student ID, optional school name, and connection time.
- Sync settings, last attempt/success/error timestamps, and the boundary through which complete timetable coverage was confirmed.
- Event source IDs, non-reversible content fingerprints, missing counters, and rotation state used for safe reconciliation.
- The identifier and display name of the dedicated calendar.
- In Firefox only, a revocable Google OAuth refresh token needed to continue synchronization after the browser or extension background context restarts.

The extension does not store Lectio page HTML, MitID data, Lectio cookies, Google passwords, or long-lived Google access tokens. Chrome and Brave leave token storage to the browser's Identity API. Firefox keeps its refresh token in local extension storage and caches its short-lived access token only in memory.

## Sent to services

- Lectio receives normal authenticated timetable requests from the student's browser.
- Chrome, Brave, and Firefox send the selected timetable fields to Google Calendar because the user explicitly connects it.
- Safari sends the selected timetable fields to Apple EventKit, which writes them to the Google calendar configured in Apple Calendar.

Lectio Sync does not send timetable fields to iCloud and does not create an iCloud calendar in this version. Apple Calendar users see the dedicated Google calendar by adding the same Google account to Apple Calendar on each device.

By default, calendar events contain the module/activity title, activity note, time, room, teacher, Lectio activity link, and cancellation state. Homework is disabled by default and is included only after the user enables it. Attached files and their contents are not copied.

## Deletion and disconnect

Disconnecting clears the relevant extension connection state. Chrome and Brave clear the browser OAuth cache; Firefox removes the locally stored refresh token and requests its revocation from Google. Disconnecting deliberately does not delete the dedicated calendar or its events, so it cannot unexpectedly erase the student's timetable. The user can delete the `Lectio` calendar in Google Calendar or Apple Calendar.

Clearing the extension's browser data or uninstalling it removes its local state according to the browser's normal extension-storage behavior. Calendar events already sent to a provider remain subject to that provider's retention controls.
