import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileFixture, fixture } from './helpers/performance-fixture.mjs';

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
  const h = fixture(bundle, { fetch: async url => url.includes('/calendars/stale?')
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
