# Security Policy

Report vulnerabilities privately to the repository owner. Do not include Lectio credentials, cookies, private timetable pages, or calendar exports in a report.

## Extension boundaries

- The extension operates independently of the separate Lectio Sync macOS app. It has no app pairing, handoff, or local app server connection.
- Account discovery messages are accepted only from content scripts running in a matching Lectio tab.
- Timetable requests use HTTPS, the exact `www.lectio.dk` host, the connected school path, and allowlisted schedule or activity endpoints.
- Calendar writes stop when the Lectio session expires, an unexpected page is returned, or the connected account or calendar changes.
- Removed events require two consecutive valid missing observations before deletion.
- Safari's bundled EventKit handler provides calendar access for the Safari extension. Public Safari distribution requires Apple signing.
