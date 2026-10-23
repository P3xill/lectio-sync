// Reproduce the submitted package using only its already-bundled Desktop OAuth metadata.
// Never prints or writes the installed-app credential to a separate file.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const archive = process.argv[2] && resolve(process.argv[2]);
if (!archive) throw new Error('Usage: node scripts/reproduce-firefox.mjs /path/to/submitted-firefox.zip');
const extract = name => execFileSync('unzip', ['-p', archive, name], { maxBuffer: 10_000_000 });
const background = extract('background.js').toString('utf8');
const ids = [...new Set(background.match(/\d{6,}-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com/gu))];
const credentials = [...new Set(background.match(/GOCSPX-[A-Za-z0-9_-]{20,}/gu))];
if (ids.length !== 1 || credentials.length !== 1) {
  throw new Error('Expected exactly one bundled Firefox Desktop OAuth client configuration.');
}
const env = { ...process.env,
  GOOGLE_FIREFOX_OAUTH_CLIENT_ID: ids[0],
  GOOGLE_FIREFOX_OAUTH_CLIENT_SECRET: credentials[0],
  CHROMIUM_OAUTH_MODE: 'brave'
};
execFileSync(process.execPath, ['scripts/build-extension.mjs', 'firefox'], { env, stdio: 'inherit' });
execFileSync(process.execPath, ['scripts/build-manifest.mjs', 'firefox'], { env, stdio: 'inherit' });
const entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).trim().split('\n');
let compared = 0;
for (const entry of entries) {
  if (entry.endsWith('/')) continue;
  if (entry.startsWith('/') || entry.split('/').includes('..')) throw new Error('Invalid archive path.');
  if (!extract(entry).equals(await readFile(resolve('dist/firefox', entry)))) {
    throw new Error(`Reproduction differs: ${entry}`);
  }
  compared++;
}
console.log(`Firefox reproduction verified: ${compared} packaged files match byte-for-byte.`);
