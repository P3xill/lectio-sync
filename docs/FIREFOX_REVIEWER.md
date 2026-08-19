# Firefox reviewer build instructions

The Firefox release is built from TypeScript with esbuild. No generated or remotely hosted code is required.

## Requirements

- Node.js 20.12 or later
- npm
- The `zip` command

## Reproduce the release package

1. Extract the source archive and run `npm ci`.
2. Provide the Google Desktop OAuth client ID and its issued installed-app client credential through environment variables. These values are supplied separately in the AMO reviewer notes and are not included in the source archive.
3. Run:

   ```sh
   GOOGLE_FIREFOX_OAUTH_CLIENT_ID="desktop-client.apps.googleusercontent.com" \
   GOOGLE_FIREFOX_OAUTH_CLIENT_SECRET=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tial \
   npm run package:firefox
   ```

4. Inspect `artifacts/lectio-sync-firefox.zip`. Its root contains `manifest.json`, the bundled JavaScript and CSS, popup HTML, and icons. Source maps and development source files are excluded.

The issued Desktop client credential is not a confidential server secret. Google requires it during token exchange for this installed-app client; PKCE protects authorization codes.
