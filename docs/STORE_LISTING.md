# Store listing source text

## Public URLs

- **Homepage:** https://lectio-sync.johannespeulicke.chatgpt.site
- **Privacy policy:** https://lectio-sync.johannespeulicke.chatgpt.site/privacy
- **Support:** https://lectio-sync.johannespeulicke.chatgpt.site/support
- **Source:** https://github.com/P3xill/lectio-sync

## Short description

Privately sync your Lectio timetable to a dedicated calendar from your browser.

## Full description

Lectio Sync helps Danish students keep their Lectio timetable in a dedicated calendar. Sign in on the real Lectio website, connect your calendar, and let the extension add, update, or mark cancelled modules.

The extension is local-first. It has no advertising, analytics, telemetry, or hosted application backend. It never asks for a Lectio password, automates MitID, or reads browser cookies directly. If Lectio returns an unexpected page or an expired session, synchronization stops before calendar changes are made.

When the student connects Google Calendar, the extension sends the selected timetable fields to Google so it can create and update the dedicated calendar. Firefox stores a revocable Google OAuth refresh token locally so background synchronization can continue after Firefox restarts. No timetable data or OAuth token is sent to Lectio Sync or any analytics service.

Features:

- Sync current and upcoming timetable weeks.
- Update changed modules without duplicates.
- Mark cancellations clearly and notify the student.
- Choose which timetable fields are copied.
- Keep homework disabled unless the student enables it.
- Disconnect without unexpectedly deleting the calendar.

## Permission explanations

- **Lectio website access:** reads timetable pages using the student's existing Lectio session.
- **Google API access:** creates and manages only the dedicated calendar created by Lectio Sync.
- **Identity:** requests the student's explicit Google authorization. Firefox stores the resulting revocable refresh token locally.
- **Storage:** keeps settings, calendar identifiers, and safe reconciliation metadata locally.
- **Alarms:** schedules best-effort background checks while the browser is available.
- **Notifications:** reports cancellations and paused synchronization.
- **Safari native messaging and Calendar access:** communicates with the signed companion app, which uses EventKit to update the dedicated calendar.

## Support statement

Supported desktop browsers are Chrome, Brave, Firefox, and Safari on macOS. Browser background scheduling is best-effort and does not run while the browser or computer is shut down.
