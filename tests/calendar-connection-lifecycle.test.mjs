import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileFixture, fixture, STATE_KEY } from './helpers/performance-fixture.mjs';

const clientId = '123456-test.apps.googleusercontent.com';
const targets = ['chrome', 'brave', 'firefox', 'safari'];
const bundles = Object.fromEntries(await Promise.all(targets.map(async target => [target,
  await compileFixture('src', target === 'brave' ? 'chrome' : target, {
    startup: true, oauthMode: target === 'brave' ? 'brave' : 'chrome', braveClientId: clientId, firefoxClientId: clientId
  })
])));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(target) {
  let calls = 0;
  const attempts = [];
  function start(details = {}) {
    calls++;
    const attempt = { ...deferred(), details };
    attempts.push(attempt);
    return attempt.promise;
  }
  const h = fixture(bundles[target], {
    state: { status: 'google_disconnected' },
    getAuthToken: () => start(),
    chromeIdentity: {
      getRedirectURL: () => 'https://fixture.chromiumapp.org/',
      launchWebAuthFlow: start
    },
    browserIdentity: {
      getRedirectURL: () => 'https://fixture.extensions.allizom.org/',
      launchWebAuthFlow: start
    },
    sendNativeMessage: async (_app, message) => message.type === 'ENSURE_CALENDAR'
      ? start() : { ok: true, data: true },
    fetch: async url => url === 'https://oauth2.googleapis.com/token'
      ? Response.json({ access_token: 'fresh', refresh_token: 'refresh' })
      : Response.json({ kind: 'calendar#events' })
  });
  function finish(index = 0) {
    const attempt = attempts[index];
    if (target === 'chrome') attempt.resolve({ token: 'fresh' });
    if (target === 'safari') attempt.resolve({ ok: true, data: { calendarId: 'calendar', calendarName: 'Lectio' } });
    if (target === 'brave' || target === 'firefox') {
      const url = new URL(attempt.details.url);
      const params = new URLSearchParams({ state: url.searchParams.get('state'), access_token: 'fresh', code: 'code' });
      attempt.resolve(target === 'brave' ? `https://fixture.chromiumapp.org/#${params}` : `${url.searchParams.get('redirect_uri')}?${params}`);
    }
  }
  return { ...h, attempts, finish, get calls() { return calls; } };
}
async function waitForLogin(h) {
  for (let i = 0; i < 50 && !h.calls; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(h.calls, 1, 'Exactly one browser login/permission request must start');
}

for (const target of targets) {
  test(`${target}: reopened popups share one connection and observe success`, async () => {
    const h = harness(target);
    const first = h.send({ type: 'CONNECT_GOOGLE' });
    await waitForLogin(h);
    assert.equal((await h.send({ type: 'GET_POPUP_STATE' })).data.calendarConnectionPending, true);
    const reopened = h.send({ type: 'CONNECT_GOOGLE' });
    h.finish();
    const results = await Promise.all([first, reopened]);
    assert.equal(results[0].ok, true, JSON.stringify(results[0]));
    assert.deepEqual(results[0], results[1]);
    assert.equal(h.calls, 1);
    assert.equal((await h.send({ type: 'GET_POPUP_STATE' })).data.calendarConnectionPending, false);
  });

  for (const reset of [false, true]) {
    test(`${target}: ${reset ? 'full reset' : 'disconnect'} rejects a late browser result without restoring state`, async () => {
      const h = harness(target);
      const pending = h.send({ type: 'CONNECT_GOOGLE' });
      await waitForLogin(h);
      assert.equal((await h.send({ type: 'DISCONNECT', target: reset ? 'all' : 'google' })).ok, true);
      const afterDisconnect = structuredClone(h.data[STATE_KEY]);
      h.finish();
      const result = await pending;
      assert.equal(result.ok, false);
      assert.deepEqual(h.data[STATE_KEY], afterDisconnect, 'Late success/error cannot overwrite disconnect or reset');
      assert.equal(h.data[STATE_KEY]?.googleCalendarId, undefined);
      assert.equal((await h.send({ type: 'GET_POPUP_STATE' })).data.calendarConnectionPending, false);
      assert.equal(h.data.lectioSyncFirefoxGoogleRefreshTokenV1, undefined);
      assert.equal(h.requests.some(r => r.url.includes('googleapis.com/calendar/')), false, 'Late auth must not reach the Calendar API');
    });
  }

  test(`${target}: cancellation releases the connection and permits one fresh retry`, async () => {
    const h = harness(target);
    const first = h.send({ type: 'CONNECT_GOOGLE' });
    await waitForLogin(h);
    h.attempts[0].reject(new Error('Sign-in cancelled'));
    assert.equal((await first).ok, false);
    assert.equal((await h.send({ type: 'GET_POPUP_STATE' })).data.calendarConnectionPending, false);
    const retry = h.send({ type: 'CONNECT_GOOGLE' });
    for (let i = 0; i < 50 && h.calls < 2; i++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(h.calls, 2);
    h.finish(1);
    assert.equal((await retry).ok, true);
  });
}

const chrome = await compileFixture();
test('Chrome: separate adapters share pending authentication across interactive and silent requests', async () => {
  const pending = deferred();
  const h = fixture(chrome, { getAuthToken: () => pending.promise });
  const first = new h.api.GoogleCalendarAdapter().ensureConnected(true, 'calendar');
  await new Promise(resolve => setImmediate(resolve));
  const silent = new h.api.GoogleCalendarAdapter().listManaged('calendar', {
    timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-10-08T00:00:00Z'
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.counts.tokens, 1);
  pending.resolve({ token: 'fresh' });
  await Promise.all([first, silent]);
  assert.equal(h.counts.tokens, 1);
});

const safari = await compileFixture('src', 'safari');

for (const succeeds of [true, false]) {
  test(`Chrome: interactive login waits for silent renewal (${succeeds ? 'success' : 'escalation'})`, async () => {
    const pending = deferred();
    const intents = [];
    const h = fixture(chrome, { getAuthToken: ({ interactive }) => {
      intents.push(interactive);
      return intents.length === 1 ? pending.promise : { token: 'fresh' };
    } });
    const silent = new h.api.GoogleCalendarAdapter().listManaged('calendar', {
      timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-10-08T00:00:00Z'
    });
    const silentOutcome = silent.catch(() => undefined);
    await new Promise(resolve => setImmediate(resolve));
    const login = new h.api.GoogleCalendarAdapter().ensureConnected(true, 'calendar');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(intents, [false]);
    if (succeeds) pending.resolve({ token: 'fresh' });
    else pending.reject(new Error('interaction_required'));
    assert.equal((await login).calendarId, 'calendar');
    await silentOutcome;
    assert.deepEqual(intents, succeeds ? [false] : [false, true]);
  });
}

test('Safari: separate adapters share permission requests and discard replies after disconnect', async () => {
  const pending = deferred();
  let ensures = 0;
  const h = fixture(safari, { sendNativeMessage: (_app, message) => {
    if (message.type === 'ENSURE_CALENDAR') { ensures++; return pending.promise; }
    return { ok: true, data: true };
  } });
  const first = new h.api.SafariCalendarAdapter().ensureConnected(true, 'calendar');
  const repeated = new h.api.SafariCalendarAdapter().ensureConnected(true, 'calendar');
  const outcome = Promise.allSettled([first, repeated]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ensures, 1);
  await new h.api.SafariCalendarAdapter().disconnect();
  pending.resolve({ ok: true, data: { calendarId: 'calendar', calendarName: 'Lectio' } });
  assert.equal((await outcome).every(r => r.status === 'rejected'), true);
});
