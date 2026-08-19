const github = "https://github.com/P3xill/lectio-sync";

export default function Home() {
  return (
    <main>
      <nav className="nav shell" aria-label="Primary navigation">
        <a className="brand" href="#top" aria-label="Lectio Sync home">
          <img src="/icon-128.png" alt="" />
          <span>Lectio Sync</span>
        </a>
        <div className="navLinks">
          <a href="#features">Features</a>
          <a href="/privacy">Privacy</a>
          <a href="/support">Support</a>
        </div>
      </nav>

      <section className="hero shell" id="top">
        <div className="heroCopy">
          <p className="eyebrow">LECTIO → CALENDAR</p>
          <h1>Your timetable. Already in your calendar.</h1>
          <p className="intro">
            Lectio Sync keeps lessons, rooms, homework and cancellations up to date in a dedicated calendar—directly from your desktop browser.
          </p>
          <div className="actions">
            <a className="button primary" href="#availability">Get Lectio Sync</a>
            <a className="button secondary" href={github}>View source</a>
          </div>
          <p className="trust">No ads · No analytics · No hosted application backend</p>
        </div>
        <div className="heroVisual">
          <img src="/product.png" alt="Lectio Sync showing a successful timetable synchronization" />
        </div>
      </section>

      <section className="section shell" id="features">
        <div className="sectionHeading">
          <p className="eyebrow">BUILT FOR A QUIETER SCHOOL WEEK</p>
          <h2>Changes arrive where you already plan your day.</h2>
        </div>
        <div className="featureGrid">
          <article><span>01</span><h3>Automatic updates</h3><p>New lessons, room changes and timetable edits stay synchronized while your browser is running.</p></article>
          <article><span>02</span><h3>Clear cancellations</h3><p>Cancelled modules are marked clearly, made free in your calendar and can trigger a desktop notification.</p></article>
          <article><span>03</span><h3>Private by design</h3><p>Your timetable goes only between Lectio, your browser and the calendar provider you explicitly connect.</p></article>
        </div>
      </section>

      <section className="privacyBand">
        <div className="shell privacyGrid">
          <div>
            <p className="eyebrow light">LOCAL-FIRST</p>
            <h2>Your schedule is not our business.</h2>
          </div>
          <div>
            <p>Lectio Sync has no analytics, advertising, telemetry, crash-reporting service or application backend. It never asks for your Lectio password and does not automate MitID.</p>
            <a className="textLink" href="/privacy">Read the complete privacy policy →</a>
          </div>
        </div>
      </section>

      <section className="section shell availability" id="availability">
        <div className="sectionHeading">
          <p className="eyebrow">SUPPORTED DESKTOP BROWSERS</p>
          <h2>One focused extension, four supported browsers.</h2>
        </div>
        <div className="browserGrid">
          {[
            ["Chrome", "Google Calendar"],
            ["Brave", "Google Calendar"],
            ["Firefox", "Google Calendar"],
            ["Safari", "Apple Calendar / EventKit"],
          ].map(([browser, calendar]) => (
            <div className="browserCard" key={browser}><strong>{browser}</strong><span>{calendar}</span><small>Coming to the official store</small></div>
          ))}
        </div>
        <p className="availabilityNote">Edge and Opera are not supported. Official store links will be added after approval.</p>
      </section>

      <footer className="footer shell">
        <a className="brand" href="#top"><img src="/icon-128.png" alt="" /><span>Lectio Sync</span></a>
        <div><a href="/privacy">Privacy</a><a href="/support">Support</a><a href={github}>GitHub</a></div>
        <p>Open-source software for Danish students.</p>
      </footer>
    </main>
  );
}
