import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';

const STATE = 'lectioSyncStateV1';
const CREDENTIAL = 'lectioSyncNativeBridgeCredentialV1';
const alarm = 'lectio-sync-periodic';
const account = { schoolId: '148', studentId: '42', connectedAt: '2026-09-01T00:00:00.000Z' };
const schedule = `<table class="s2skema"><tr><td data-date="2026-09-30"><a class="s2skemabrik" href="/lectio/148/SkemaNy.aspx?absid=123" data-tooltip="Mathematics&#10;30/9-2026 08:00 til 09:00&#10;Hold: 3x">Mathematics</a></td></tr></table>`;
const bundle = await build({
  stdin: { contents: `import './src/background'; import { runSync, scheduleNextSync } from './src/core/sync-engine'; globalThis.testEngine = { runSync, scheduleNextSync };`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'iife', platform: 'browser',
  define: { __TARGET_BROWSER__: '"chrome"', __CHROMIUM_OAUTH_MODE__: '"chrome"', __GOOGLE_FIREFOX_OAUTH_CLIENT_ID__: '"fixture"', __GOOGLE_FIREFOX_OAUTH_CLIENT_SECRET__: '"fixture"', __GOOGLE_BRAVE_OAUTH_CLIENT_ID__: '"fixture"' },
  plugins: [{ name: 'browser-fixture', setup(build) {
    build.onResolve({ filter: /^webextension-polyfill$/ }, () => ({ path: 'browser', namespace: 'fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export default globalThis.testBrowser;', loader: 'js' }));
  } }]
});

async function harness(mode = 'none', options = {}) {
  const data = { [STATE]: { nativeBridgeMode: mode, status: 'healthy', lectioAccount: account, googleCalendarId: 'calendar', settings: { horizonWeeks: 2 }, sourceSnapshots: {} } };
  if (options.credential) data[CREDENTIAL] = 'a'.repeat(43);
  const alarms = new Map(mode === 'nativeActive' ? [] : [[alarm, { periodInMinutes: 10 }]]);
  const listeners = {};
  const events = [];
  const requests = [];
  const timers = new Set();
  const event = (name) => ({ addListener: fn => { listeners[name] = fn; } });
  const browser = {
    storage: { local: {
      get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in data).map(key => [key, structuredClone(data[key])])),
      set: async values => Object.assign(data, structuredClone(values)),
      remove: async key => { delete data[key]; }
    } },
    runtime: { onMessage: event('message'), onInstalled: event('installed'), onStartup: event('startup'), getPlatformInfo: async () => ({ os: 'mac' }), getURL: path => `chrome-extension://fixture/${path}` },
    alarms: { clear: async key => alarms.delete(key), create: async (key, value) => { alarms.set(key, value); }, onAlarm: event('alarm') },
    tabs: { onRemoved: event('removed'), onUpdated: event('updated'), query: async () => [], create: async () => ({}) },
    notifications: { onClicked: event('notification'), create: async () => {} }
  };
  const fetch = async (raw, init = {}) => {
    const url = String(raw);
    requests.push({ url, method: init.method ?? 'GET' });
    if (url.startsWith('http://127.0.0.1')) {
      throw new Error('Unexpected local app connection');
    }
    if (url.startsWith('https://www.lectio.dk')) {
      const response = new Response(options.expired ? 'Log ind med MitID' : schedule);
      Object.defineProperty(response, 'url', { value: url });
      return response;
    }
    if (url.startsWith('https://www.googleapis.com/calendar/v3/')) {
      if (init.method === 'POST' && new URL(url).pathname.endsWith('/events')) {
        const value = JSON.parse(init.body); events.push(value); return Response.json(value);
      }
      if (url.includes('/events?')) return Response.json({ items: events });
      return Response.json({ id: 'calendar' });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const context = vm.createContext({ testBrowser: browser, chrome: {
    identity: { getAuthToken: async () => {
      if (options.authError) throw new Error(options.authError);
      return { token: 'fixture-token' };
    } },
    runtime: { getManifest: () => ({ oauth2: { client_id: '123456-test.apps.googleusercontent.com' } }) }
  }, fetch, Response, Headers, URL, URLSearchParams, AbortSignal, TextEncoder, TextDecoder, crypto: webcrypto, atob, btoa, console,
  setTimeout: (fn, ms) => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timer.unref(); timers.add(timer); return timer; }, clearTimeout });
  vm.runInContext(bundle.outputFiles[0].text, context);
  const send = (message, sender = {}) => listeners.message(message, sender);
  return { data, alarms, events, requests, listeners, send, engine: context.testEngine, cleanup: () => { for (const timer of timers) clearTimeout(timer); } };
}

for (const mode of ['pendingNativeActivation', 'nativeActive']) {
  test(`Upgrading ${mode} restores independent sync and clears pairing data`, async () => {
    const h = await harness(mode, { credential: true });
    try {
      const result = await h.send({ type: 'GET_STATE' });
      assert.equal(result.ok, true);
      assert.equal('nativeBridgeMode' in result.data, false);
      assert.equal('nativeBridgeMode' in h.data[STATE], false);
      assert.equal(result.data.googleCalendarId, 'calendar');
      assert.equal(h.data[CREDENTIAL], undefined);
      h.listeners.installed();
      await new Promise(resolve => setImmediate(resolve));
      assert.ok(h.alarms.has(alarm));
      assert.ok(h.data[STATE].nextSyncAt);
      const sync = await h.send({ type: 'SYNC_NOW' });
      assert.equal(sync.ok, true, JSON.stringify(sync.error));
      assert.equal(sync.data.inserted, 1);
      assert.equal(h.data[STATE].status, 'healthy');
      assert.equal(h.requests.some(request => request.url.startsWith('http://127.0.0.1')), false);
    } finally { h.cleanup(); }
  });
}

test('Standalone extension syncs a parsed Lectio event to Google and a repeat sync makes no duplicates', async () => {
  const h = await harness();
  try {
    const result = await h.send({ type: 'SYNC_NOW' });
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(result.data.inserted, 1);
    assert.equal(h.data[STATE].status, 'healthy');
    assert.ok(h.data[STATE].lastSuccessAt);
    assert.equal(h.events[0].summary, 'Mathematics');
    assert.ok(h.alarms.has(alarm));
    const repeat = await h.send({ type: 'SYNC_NOW' });
    assert.equal(repeat.ok, true);
    assert.equal(repeat.data.inserted, 0);
    assert.equal(h.events.length, 1);
  } finally { h.cleanup(); }
});

for (const authError of [
  'Access blocked: Lectio Google calendar integration has not completed the Google verification process',
  'The app is currently being tested and can only be accessed by developer-approved testers',
  'Google authorization failed: access_denied'
]) {
  test(`Blocked Google connection explains recovery and makes no calendar requests: ${authError}`, async () => {
    const h = await harness('none', { authError });
    try {
      const result = await h.send({ type: 'CONNECT_GOOGLE' });
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'GOOGLE_AUTH_REQUIRED');
      assert.match(result.error.message, /contact Lectio Sync support/i);
      assert.match(result.error.message, /Google Cloud/);
      if (authError.includes('access_denied')) assert.match(result.error.message, /If you declined permission/);
      assert.equal(h.data[STATE].status, 'google_disconnected');
      const reloaded = await h.send({ type: 'GET_STATE' });
      assert.equal(reloaded.data.lastError.message, result.error.message);
      assert.equal(h.requests.length, 0);
    } finally { h.cleanup(); }
  });
}

test('Silent sync preserves the Google verification explanation without calendar writes', async () => {
  const h = await harness('none', { authError: 'App has not completed the Google verification process' });
  try {
    const result = await h.send({ type: 'SYNC_NOW' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'GOOGLE_AUTH_REQUIRED');
    assert.match(result.error.message, /Google Cloud/);
    assert.equal(h.data[STATE].status, 'google_disconnected');
    assert.equal(h.requests.some(request => request.url.startsWith('https://www.googleapis.com/')), false);
  } finally { h.cleanup(); }
});

test('Account discovery schedules independent sync after an account change', async () => {
  const h = await harness();
  try {
    const url = 'https://www.lectio.dk/lectio/148/SkemaNy.aspx';
    const result = await h.send({ type: 'LECTIO_PAGE_SEEN', url, studentId: '43' }, { url });
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.ok(h.alarms.has(alarm));
    assert.equal(h.data[STATE].lectioAccount.studentId, '43');
  } finally { h.cleanup(); }
});

test('Expired Lectio session makes no Google event writes and reports recovery state', async () => {
  const h = await harness('none', { expired: true });
  try {
    const result = await h.send({ type: 'SYNC_NOW' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'LECTIO_AUTH_REQUIRED');
    assert.equal(h.events.length, 0);
    assert.equal(h.data[STATE].status, 'lectio_expired');
  } finally { h.cleanup(); }
});

test('Former app commands are rejected without making requests', async () => {
  const h = await harness();
  try {
    for (const type of ['PAIR_NATIVE_APP', 'START_NATIVE_HANDOFF', 'OPEN_NATIVE_APP', 'RESUME_GOOGLE_SYNC', 'DISMISS_NATIVE_PROMOTION']) {
      const result = await h.send({ type, token: 'a'.repeat(43), version: 1 });
      assert.equal(result.ok, false);
    }
    assert.equal(h.requests.length, 0);
  } finally { h.cleanup(); }
});

test('Startup and settings changes schedule sync even with obsolete active-app state', async () => {
  const h = await harness('nativeActive', { credential: true });
  try {
    h.listeners.startup();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(h.alarms.has(alarm));
    const settings = await h.send({ type: 'UPDATE_SETTINGS', settings: { intervalMinutes: 15 } });
    assert.equal(settings.ok, true);
    assert.equal(h.alarms.get(alarm).periodInMinutes, 15);
    assert.equal(h.requests.length, 0);
  } finally { h.cleanup(); }
});

test('Rediscovering an unchanged Lectio account avoids a storage rewrite', async () => {
  const h = await harness();
  try {
    await h.send({ type: 'GET_STATE' });
    const previous = h.data[STATE];
    const url = 'https://www.lectio.dk/lectio/148/SkemaNy.aspx';
    const result = await h.send({ type: 'LECTIO_PAGE_SEEN', url, studentId: '42' }, { url });
    assert.equal(result.ok, true);
    assert.equal(h.data[STATE], previous);
  } finally { h.cleanup(); }
});

test('Popup state omits reconciliation snapshots without removing stored history', async () => {
  const h = await harness('nativeActive');
  try {
    h.data[STATE].sourceSnapshots = { 'absid:123': { fingerprint: 'abc', missingStreak: 1, lastSeenAt: '2026-10-02T12:00:00Z' } };
    const popup = await h.send({ type: 'GET_POPUP_STATE' });
    assert.equal(popup.ok, true);
    assert.equal(Object.keys(popup.data.sourceSnapshots).length, 0);
    assert.equal(popup.data.lectioAccount.studentId, '42');
    assert.equal(h.data[STATE].sourceSnapshots['absid:123'].missingStreak, 1);
    assert.equal('nativeBridgeMode' in h.data[STATE], false);
    const full = await h.send({ type: 'GET_STATE' });
    assert.equal(full.data.sourceSnapshots['absid:123'].missingStreak, 1);
  } finally { h.cleanup(); }
});
