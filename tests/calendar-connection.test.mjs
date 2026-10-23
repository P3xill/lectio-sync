import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileFixture, fixture, STATE_KEY, schedule, activity } from './helpers/performance-fixture.mjs';

const bundle = await compileFixture();
const ownershipKey = 'lectioSyncOwnedGoogleCalendarV1';

test('A colour failure followed by a restart reuses the calendar already created', async () => {
  let created = 0, failColour = true;
  const fetch = async (url, init) => {
    if (init.method === 'POST') { created++; return Response.json({ id: 'owned' }); }
    if (init.method === 'PATCH' && failColour) return new Response('colour unavailable', { status: 500 });
    return Response.json({ id: 'owned' });
  };
  const first = fixture(bundle, { fetch });
  await assert.rejects(new first.api.GoogleCalendarAdapter().ensureConnected(true, undefined, '#007AFF'), /colour unavailable/);
  assert.equal(first.data[ownershipKey], 'owned');
  const restarted = fixture(bundle, { fetch });
  restarted.data[ownershipKey] = first.data[ownershipKey];
  failColour = false;
  const connected = await new restarted.api.GoogleCalendarAdapter().ensureConnected(true, undefined, '#007AFF');
  assert.equal(connected.calendarId, 'owned');
  assert.equal(created, 1);
});

test('Concurrent connections through separate adapters create only one calendar', async () => {
  let created = 0;
  const h = fixture(bundle, { fetch: async (url, init) => {
    if (init.method === 'POST') {
      created++;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return Response.json({ id: 'owned' });
  } });
  const results = await Promise.all([
    new h.api.GoogleCalendarAdapter().ensureConnected(true),
    new h.api.GoogleCalendarAdapter().ensureConnected(true)
  ]);
  assert.equal(created, 1);
  assert.equal(results[0].calendarId, results[1].calendarId);
});

test('A stale state id reuses the separately saved replacement', async () => {
  const h = fixture(bundle, { fetch: async url => url.includes('/calendars/stale/events?')
    ? new Response('missing', { status: 404 }) : Response.json({ id: 'owned' }) });
  h.data[ownershipKey] = 'owned';
  const result = await new h.api.GoogleCalendarAdapter().ensureConnected(false, 'stale');
  assert.equal(result.calendarId, 'owned');
  assert.equal(h.requests.some(request => request.method === 'POST'), false);
});

test('An access or server error never creates a replacement calendar', async () => {
  for (const status of [401, 403, 429, 500]) {
    const h = fixture(bundle, { fetch: async () => new Response('unavailable', { status }) });
    h.data[ownershipKey] = 'owned';
    await assert.rejects(new h.api.GoogleCalendarAdapter().ensureConnected(false), error => error.status === status);
    assert.equal(h.requests.some(request => request.method === 'POST'), false);
    assert.equal(h.data[ownershipKey], 'owned');
  }
});

test('An existing calendar is verified with event access even when calendar metadata is denied', async () => {
  const h = fixture(bundle, { fetch: async url => new URL(url).pathname.endsWith('/events')
    ? Response.json({ kind: 'calendar#events' })
    : Response.json({ error: { code: 401, message: 'Invalid Credentials' } }, { status: 401 }) });
  const connected = await new h.api.GoogleCalendarAdapter().ensureConnected(false, 'existing');
  assert.equal(connected.calendarId, 'existing');
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].method ?? 'GET', 'GET');
  assert.equal(new URL(h.requests[0].url).pathname, '/calendar/v3/calendars/existing/events');
  assert.equal(h.data[ownershipKey], 'existing');
});

test('Explicit recovery saves only a verified secondary calendar and never creates a replacement', async () => {
  const calendarId = 'recovered@group.calendar.google.com';
  const h = fixture(bundle, { state: { googleCalendarId: undefined }, fetch: async () => Response.json({ kind: 'calendar#events' }) });
  const connected = await h.api.connectCalendar(true, calendarId);
  assert.equal(connected.googleCalendarId, calendarId);
  assert.equal(h.data[ownershipKey], calendarId);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].method ?? 'GET', 'GET');

  for (const status of [401, 403, 404, 410, 500]) {
    const denied = fixture(bundle, { fetch: async () => new Response('denied', { status }) });
    denied.data[ownershipKey] = 'previous';
    await assert.rejects(new denied.api.GoogleCalendarAdapter().useExistingCalendar(calendarId, false));
    assert.equal(denied.data[ownershipKey], 'previous');
    assert.equal(denied.requests.some(r => r.method === 'POST'), false);
  }
  for (const id of ['primary', 'someone@gmail.com', 'https://example.com', 'x'.repeat(513)]) {
    await assert.rejects(new h.api.GoogleCalendarAdapter().useExistingCalendar(id, true));
  }
  assert.equal(h.requests.length, 1);
});

test('Calendar creation limits explain recovery and do not retry or save a phantom calendar', async () => {
  const h = fixture(bundle, { fetch: async () => Response.json({ error: {
    errors: [{ reason: 'quotaExceeded', message: 'Calendar usage limits exceeded.' }], code: 403
  } }, { status: 403 }) });
  await assert.rejects(new h.api.GoogleCalendarAdapter().ensureConnected(true), error => {
    assert.equal(error.code, 'GOOGLE_API');
    assert.match(error.message, /Use an existing Lectio calendar/);
    assert.match(error.technicalDetail, /quotaExceeded/);
    return true;
  });
  assert.equal(h.requests.length, 1);
  assert.equal(h.data[ownershipKey], undefined);
});

for (const target of ['chrome', 'firefox']) {
  test(`${target}: metadata and colour denials do not block event access or create duplicate calendars`, async () => {
    const compiled = target === 'chrome' ? bundle : await compileFixture('src', target);
    let created = 0;
    const h = fixture(compiled, {
      state: { googleCalendarId: undefined, status: 'not_configured' },
      fetch: async (url, init, { events }) => {
        if (url === 'https://oauth2.googleapis.com/token') {
          return Response.json({ access_token: 'valid-event-token', expires_in: 3600 });
        }
        if (url.startsWith('https://www.lectio.dk')) {
          const response = new Response(url.includes('/aktivitet/') ? activity : schedule);
          Object.defineProperty(response, 'url', { value: url });
          return response;
        }
        const path = new URL(url).pathname;
        if (init.method === 'POST' && path.endsWith('/calendars')) {
          created++;
          return Response.json({ id: 'owned' });
        }
        if (path.includes('/calendarList/') || path.endsWith('/calendars/owned')) {
          return Response.json({ error: { code: 401, message: 'Invalid Credentials' } }, { status: 401 });
        }
        if (init.method === 'POST' && path.endsWith('/events')) {
          const resource = JSON.parse(init.body);
          events.push(resource);
          return Response.json({ id: resource.id });
        }
        if (path.endsWith('/events')) return Response.json({ kind: 'calendar#events', items: events });
        throw new Error(`Unexpected request: ${init.method ?? 'GET'} ${path}`);
      }
    });
    h.data.lectioSyncFirefoxGoogleRefreshTokenV1 = 'user-refresh';
    const connected = await h.api.connectCalendar(true);
    assert.equal(connected.googleCalendarId, 'owned');
    const first = await h.api.runSync(true);
    assert.equal(first.inserted, 1);
    const second = await h.api.runSync(true);
    assert.equal(second.inserted, 0);
    assert.equal(h.events.length, 1);
    assert.equal(created, 1);
    assert.equal(h.data[STATE_KEY].status, 'healthy');
    assert.equal(h.requests.some(r => new URL(r.url).pathname.endsWith('/calendars/owned')), false);

    // Restoring a calendar after lost state also uses event access, preserving
    // the owned calendar even when its colour cannot be changed.
    const restored = await new h.api.GoogleCalendarAdapter().ensureConnected(false, undefined, '#007AFF');
    assert.equal(restored.calendarId, 'owned');
    assert.equal(created, 1);
    // An explicit settings change must still surface the denied colour write.
    await assert.rejects(new h.api.GoogleCalendarAdapter().setColor('owned', '#007AFF'), error => error.status === 401);
  });
}
