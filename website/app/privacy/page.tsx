export default function Privacy() {
  return (
    <main className="policy">
      <a className="back" href="/">← Lectio Sync</a>
      <p className="eyebrow">PRIVACY POLICY</p>
      <h1>Private by design.</h1>
      <p className="updated">Last updated 15 August 2026</p>
      <p>Lectio Sync has no analytics, advertising, telemetry, crash-reporting service or application backend.</p>

      <h2>Stored locally</h2>
      <ul>
        <li>Lectio school ID, student ID, optional school name and connection time.</li>
        <li>Sync settings, status timestamps and reconciliation metadata.</li>
        <li>The identifier and display name of the dedicated calendar.</li>
        <li>In Firefox only, a revocable Google OAuth refresh token required for synchronization after restart.</li>
      </ul>
      <p>The extension does not store Lectio page HTML, MitID data, Lectio cookies, Google passwords or long-lived Google access tokens. Chrome and Brave leave token storage to the browser. Firefox caches short-lived access tokens only in memory.</p>

      <h2>Sent to services</h2>
      <ul>
        <li>Lectio receives normal authenticated timetable requests from the student’s browser.</li>
        <li>Chrome, Brave and Firefox send selected timetable fields to Google Calendar after the user explicitly connects it.</li>
        <li>Safari sends selected timetable fields to Apple EventKit, which writes them to the Google calendar configured in Apple Calendar.</li>
      </ul>
      <p>Calendar events can contain the activity title, note, time, room, teacher, Lectio activity link and cancellation state. Homework is disabled by default. Attached files and their contents are not copied.</p>

      <h2>Deletion and disconnect</h2>
      <p>Disconnecting clears the relevant extension connection state. Firefox also removes its locally stored refresh token and requests revocation from Google. Disconnecting does not delete the dedicated calendar or existing events; the user can delete the Lectio calendar through Google Calendar or Apple Calendar.</p>
      <p>Clearing browser extension data or uninstalling removes local state according to the browser’s normal storage behavior. Calendar events already sent to a provider remain subject to that provider’s retention controls.</p>
    </main>
  );
}
