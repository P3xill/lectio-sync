import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileFixture, fixture, STATE_KEY, schedule, activity } from './helpers/performance-fixture.mjs';

const chrome = await compileFixture();
const firefox = await compileFixture('src', 'firefox');
const brave = await compileFixture('src', 'chrome', {
  oauthMode: 'brave', braveClientId: '123456-test.apps.googleusercontent.com'
});
const window = { timeMin: '2026-09-28T00:00:00Z', timeMax: '2026-10-05T00:00:00Z' };
const invalidCredentials = JSON.stringify({ error: { code: 401, message: 'Invalid Credentials' } });
const denied = () => new Response(invalidCredentials, { status: 401 });

for (const interactive of [false, true]) {
  test(`Chrome renews a rejected token and reuses the existing calendar (interactive=${interactive})`, async () => {
    const removed = [], intents = [];
    let invalidated = false;
    const h = fixture(chrome, {
      getAuthToken: details => { intents.push(details.interactive); return { token: invalidated ? 'fresh' : 'stale' }; },
      removeCachedAuthToken: ({ token }) => { removed.push(token); invalidated = true; },
      fetch: async (_url, init) => init.headers.Authorization === 'Bearer stale' ? denied() : Response.json({ id: 'calendar' })
    });
    const connected = await new h.api.GoogleCalendarAdapter().ensureConnected(interactive, 'calendar');
    assert.equal(connected.calendarId, 'calendar');
    assert.deepEqual(removed, ['stale']);
    assert.deepEqual(intents, [interactive, interactive]);
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests.some(r => r.method === 'POST'), false);
  });
}

test('Concurrent and late 401 responses share one renewal without clearing the fresh token', async () => {
  const removed = [];
  let staleRequests = 0;
  const h = fixture(chrome, {
    getAuthToken: (_details, count) => ({ token: count === 1 ? 'stale' : 'fresh' }),
    removeCachedAuthToken: ({ token }) => { removed.push(token); },
    fetch: async (_url, init) => {
      if (init.headers.Authorization === 'Bearer stale') {
        if (++staleRequests === 2) await new Promise(resolve => setTimeout(resolve, 25));
        return denied();
      }
      return Response.json({ items: [] });
    }
  });
  const adapter = new h.api.GoogleCalendarAdapter();
  await Promise.all([adapter.listManaged('calendar', window), adapter.listManaged('calendar', window)]);
  assert.deepEqual(removed, ['stale']);
  assert.equal(h.counts.tokens, 2);
  assert.equal(h.requests.length, 4);
});

test('Persistent 401 is bounded, gives recovery instructions and preserves technical details', async () => {
  const h = fixture(chrome, { fetch: async () => denied() });
  await assert.rejects(new h.api.GoogleCalendarAdapter().listManaged('calendar', window), error => {
    assert.equal(error.code, 'GOOGLE_AUTH_REQUIRED');
    assert.match(error.message, /Reconnect Google Calendar/);
    assert.equal(error.technicalDetail, invalidCredentials);
    return true;
  });
  assert.equal(h.requests.length, 2);
  assert.equal(h.counts.tokens, 2);
});

test('Failed silent renewal does not open consent or create another calendar', async () => {
  const h = fixture(chrome, {
    getAuthToken: ({ interactive }, count) => {
      assert.equal(interactive, false);
      if (count === 2) throw new Error('User must sign in');
      return { token: 'stale' };
    }, fetch: async () => denied()
  });
  await assert.rejects(new h.api.GoogleCalendarAdapter().ensureConnected(false, 'calendar'), error => error.code === 'GOOGLE_AUTH_REQUIRED');
  assert.equal(h.requests.length, 1);
});

test('Firefox refreshes a rejected access token while keeping the refresh credential', async () => {
  let refreshed = 0;
  const h = fixture(firefox, { fetch: async (url, init) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      assert.equal(new URLSearchParams(init.body).get('refresh_token'), 'user-refresh');
      return Response.json({ access_token: ++refreshed === 1 ? 'stale' : 'fresh', expires_in: 3600 });
    }
    return init.headers.Authorization === 'Bearer stale' ? denied() : Response.json({ items: [] });
  } });
  h.data.lectioSyncFirefoxGoogleRefreshTokenV1 = 'user-refresh';
  await new h.api.GoogleCalendarAdapter().listManaged('calendar', window);
  assert.equal(refreshed, 2);
  assert.equal(h.data.lectioSyncFirefoxGoogleRefreshTokenV1, 'user-refresh');
});

for (const chromeCacheApi of ['unavailable', 'unsupported']) {
test(`Brave renews its own rejected cache when Chrome cache removal is ${chromeCacheApi}`, async () => {
  let authorizations = 0;
  const h = fixture(brave, {
    chromeIdentity: {
      removeCachedAuthToken: chromeCacheApi === 'unavailable' ? undefined : async () => { throw new Error('Brave must not use Chrome token cache APIs'); },
      getRedirectURL: () => 'https://fixture.chromiumapp.org/',
      launchWebAuthFlow: async ({ url, interactive }) => {
        assert.equal(interactive, false);
        const params = new URLSearchParams({ state: new URL(url).searchParams.get('state'), access_token: ++authorizations === 1 ? 'stale' : 'fresh', expires_in: '3600' });
        return `https://fixture.chromiumapp.org/#${params}`;
      }
    },
    fetch: async (_url, init) => init.headers.Authorization === 'Bearer stale' ? denied() : Response.json({ items: [] })
  });
  await new h.api.GoogleCalendarAdapter().listManaged('calendar', window);
  assert.equal(authorizations, 2);
});
}

test('A full sync recovers credentials without pausing or creating duplicate events', async () => {
  const h = fixture(chrome, {
    getAuthToken: (_details, count) => ({ token: count === 1 ? 'stale' : 'fresh' }),
    fetch: async (url, init, { events }) => {
      if (url.startsWith('https://www.lectio.dk')) {
        const response = new Response(url.includes('/aktivitet/') ? activity : schedule);
        Object.defineProperty(response, 'url', { value: url });
        return response;
      }
      if (init.headers.Authorization === 'Bearer stale') return denied();
      if (init.method === 'POST' && new URL(url).pathname.endsWith('/events')) {
        const resource = JSON.parse(init.body);
        events.push(resource);
        return Response.json({ id: resource.id });
      }
      return Response.json({ id: 'calendar', items: events });
    }
  });
  const summary = await h.api.runSync(true);
  assert.equal(summary.inserted, 1);
  assert.equal(h.data[STATE_KEY].status, 'healthy');
  assert.equal(h.events.length, 1);
  assert.equal(h.requests.filter(r => r.method === 'POST').length, 1);
  const repeat = await h.api.runSync(true);
  assert.equal(repeat.inserted, 0);
  assert.equal(h.events.length, 1);
});

test('A rejected calendar write retries the identical event and counts it once', async () => {
  const accepted = [];
  const h = fixture(chrome, {
    getAuthToken: (_details, count) => ({ token: count === 1 ? 'stale' : 'fresh' }),
    fetch: async (_url, init) => {
      if (init.headers.Authorization === 'Bearer stale') return denied();
      accepted.push(JSON.parse(init.body));
      return Response.json({ id: accepted[0].id });
    }
  });
  const event = await h.api.toCalendarEvent(h.api.parseLectioSchedule(schedule).events[0],
    (await h.api.getState()).lectioAccount, (await h.api.getState()).settings);
  const result = await new h.api.GoogleCalendarAdapter().apply('calendar', [{ kind: 'insert', event }]);
  assert.equal(result.inserted, 1);
  assert.equal(accepted.length, 1);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[0].body, h.requests[1].body);
});

test('Persistent rejection during sync preserves diagnosis and makes no event writes', async () => {
  const h = fixture(chrome, { fetch: async (url) => {
    if (url.startsWith('https://www.lectio.dk')) {
      const response = new Response(url.includes('/aktivitet/') ? activity : schedule);
      Object.defineProperty(response, 'url', { value: url });
      return response;
    }
    return denied();
  } });
  await assert.rejects(h.api.runSync(true), error => error.code === 'GOOGLE_AUTH_REQUIRED');
  const error = h.data[STATE_KEY].lastError;
  assert.equal(h.data[STATE_KEY].status, 'google_disconnected');
  assert.match(error.message, /Reconnect Google Calendar/);
  assert.equal(error.technicalDetail, invalidCredentials);
  assert.equal(h.requests.some(r => r.method === 'POST'), false);
});
