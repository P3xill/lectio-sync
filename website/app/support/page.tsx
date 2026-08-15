const issues = "https://github.com/P3xill/lectio-sync/issues";

export default function Support() {
  return (
    <main className="policy">
      <a className="back" href="/">← Lectio Sync</a>
      <p className="eyebrow">SUPPORT</p>
      <h1>Let’s get your sync moving again.</h1>
      <p>Lectio Sync supports Chrome, Brave, Firefox and Safari on macOS. Edge and Opera are not supported.</p>
      <h2>Quick checks</h2>
      <ol>
        <li>Open Lectio in the same browser and confirm that you are still signed in.</li>
        <li>Open Lectio Sync and use <strong>Sync now</strong>.</li>
        <li>If the session expired, sign in again on the real Lectio website and retry.</li>
        <li>For Safari, confirm that the Google account is configured in Apple Calendar and Calendar access is allowed.</li>
      </ol>
      <h2>Report a problem</h2>
      <p>Please open a GitHub issue with your browser version, the exact error shown by Lectio Sync and safe reproduction steps. Never include student IDs, timetable screenshots, cookies, OAuth codes or authentication details.</p>
      <p><a className="button primary" href={issues}>Open a support issue</a></p>
      <h2>Scheduling limitation</h2>
      <p>Background checks are best-effort. They cannot run while the browser or computer is shut down and resume when the desktop browser is available again.</p>
    </main>
  );
}
