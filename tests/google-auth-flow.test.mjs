import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileFixture, fixture } from './helpers/performance-fixture.mjs';

const bundle = await compileFixture('src', 'chrome', {
  oauthMode: 'brave', braveClientId: '123456-test.apps.googleusercontent.com'
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness() {
  const calls = [];
  const h = fixture(bundle, { chromeIdentity: {
    getRedirectURL: () => 'https://fixture.chromiumapp.org/',
    launchWebAuthFlow: details => {
      const result = deferred();
      calls.push({ ...details, ...result });
      return result.promise;
    }
  } });
  function finish(index, token = 'fresh') {
    const call = calls[index];
    const params = new URLSearchParams({ state: new URL(call.url).searchParams.get('state'), access_token: token });
    call.resolve(`https://fixture.chromiumapp.org/#${params}`);
  }
  return { ...h, calls, finish };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Reopening the popup and reconnecting shares the existing interactive login', async () => {
  const h = harness();
  const first = h.api.getBraveGoogleToken(true);
  const reopened = h.api.getBraveGoogleToken(true);
  assert.equal(h.calls.length, 1);
  h.finish(0);
  assert.deepEqual(await Promise.all([first, reopened]), ['fresh', 'fresh']);
});

test('Silent synchronization waits for an existing interactive login', async () => {
  const h = harness();
  const login = h.api.getBraveGoogleToken(true);
  const sync = h.api.getBraveGoogleToken(false);
  assert.equal(h.calls.length, 1);
  h.finish(0);
  assert.deepEqual(await Promise.all([login, sync]), ['fresh', 'fresh']);
});

for (const succeeds of [true, false]) {
  test(`Reconnect waits for silent renewal, then ${succeeds ? 'uses its token' : 'opens exactly one consent window'}`, async () => {
    const h = harness();
    const silent = h.api.getBraveGoogleToken(false);
    const silentOutcome = silent.catch(() => undefined);
    const login = h.api.getBraveGoogleToken(true);
    const repeated = h.api.getBraveGoogleToken(true);
    assert.equal(h.calls.length, 1);
    if (succeeds) h.finish(0);
    else h.calls[0].reject(new Error('interaction_required'));
    await tick();
    assert.equal(h.calls.length, succeeds ? 1 : 2);
    if (!succeeds) {
      assert.equal(h.calls[1].interactive, true);
      h.finish(1);
    }
    assert.deepEqual(await Promise.all([login, repeated]), ['fresh', 'fresh']);
    await silentOutcome;
  });
}

test('An orphaned browser login gives actionable instructions and retry succeeds after it closes', async () => {
  const h = harness();
  const connect = new h.api.GoogleCalendarAdapter().ensureConnected(true, 'calendar');
  await tick();
  h.calls[0].reject(new Error('Only one web auth flow is allowed at a time.'));
  await assert.rejects(connect, error => {
    assert.equal(error.code, 'GOOGLE_AUTH_REQUIRED');
    assert.match(error.message, /already open/i);
    assert.match(error.message, /restart/i);
    assert.match(error.technicalDetail, /Only one web auth flow/);
    return true;
  });
  const retry = new h.api.GoogleCalendarAdapter().ensureConnected(true, 'calendar');
  await tick();
  h.finish(1);
  assert.equal((await retry).calendarId, 'calendar');
  assert.equal(h.requests.some(r => r.method === 'POST'), false);
});

test('Cancellation releases the login so the next user attempt can succeed', async () => {
  const h = harness();
  const login = h.api.getBraveGoogleToken(true);
  h.calls[0].reject(new Error('The user did not approve access.'));
  await assert.rejects(login);
  const retry = h.api.getBraveGoogleToken(true);
  h.finish(1);
  assert.equal(await retry, 'fresh');
});

test('Disconnect during login rejects its late result and does not cache it', async () => {
  const h = harness();
  const login = h.api.getBraveGoogleToken(true);
  await h.api.disconnectBraveGoogle();
  h.finish(0, 'disconnected-token');
  await assert.rejects(login, /disconnected/i);
  const retry = h.api.getBraveGoogleToken(true);
  assert.equal(h.calls.length, 2);
  h.finish(1);
  assert.equal(await retry, 'fresh');
});

const firefox = await compileFixture('src', 'firefox', {
  firefoxClientId: '123456-test.apps.googleusercontent.com'
});
test('Firefox: reconnect after disconnect cannot overlap the original consent window', async () => {
  const opened = deferred(), closed = deferred();
  let calls = 0;
  const h = fixture(firefox, { browserIdentity: {
    getRedirectURL: () => 'https://fixture.extensions.allizom.org/',
    launchWebAuthFlow: () => { calls++; opened.resolve(); return closed.promise; }
  } });
  const first = h.api.getFirefoxGoogleToken(true);
  const firstOutcome = first.catch(error => error);
  await opened.promise;
  await h.api.disconnectFirefoxGoogle();
  const retry = h.api.getFirefoxGoogleToken(true);
  const retryOutcome = retry.catch(error => error);
  await tick();
  assert.equal(calls, 1, 'Disconnect must not forget the browser-owned window');
  closed.reject(new Error('The user did not approve access.'));
  assert.match(String(await firstOutcome), /approve access/);
  assert.match(String(await retryOutcome), /approve access/);
});

test('Firefox: interactive and silent renewal share one refresh request', async () => {
  const refreshing = deferred();
  let calls = 0;
  const h = fixture(firefox, { fetch: () => { calls++; return refreshing.promise; } });
  h.data.lectioSyncFirefoxGoogleRefreshTokenV1 = 'refresh';
  const silent = h.api.getFirefoxGoogleToken(false);
  await tick();
  const login = h.api.getFirefoxGoogleToken(true);
  await tick();
  assert.equal(calls, 1);
  refreshing.resolve(Response.json({ access_token: 'fresh' }));
  assert.deepEqual(await Promise.all([silent, login]), ['fresh', 'fresh']);
});
