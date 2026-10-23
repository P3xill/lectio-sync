import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileFixture, fixture, STATE_KEY, schedule, activity } from './helpers/performance-fixture.mjs';

const window = { timeMin: '2026-09-28T00:00:00Z', timeMax: '2026-10-05T00:00:00Z' };
const ownershipKey = 'lectioSyncOwnedGoogleCalendarV1';
const refreshKey = 'lectioSyncFirefoxGoogleRefreshTokenV1';
const compiled = Object.fromEntries(await Promise.all(['chrome', 'firefox'].map(async target => [target, await compileFixture('src', target)])));
function create(target, options) {
  const h = fixture(compiled[target], options);
  h.data[refreshKey] = 'fixture-refresh';
  h.data[ownershipKey] = 'calendar';
  return h;
}
function oauth(url) {
  return url === 'https://oauth2.googleapis.com/token'
    ? Response.json({ access_token: 'fresh', expires_in: 3600 }) : undefined;
}
function lectio(url) {
  if (!url.startsWith('https://www.lectio.dk')) return undefined;
  const response = new Response(url.includes('/aktivitet/') ? activity : schedule);
  Object.defineProperty(response, 'url', { value: url });
  return response;
}
function immediateDelays(delays) {
  return (fn, ms) => { delays.push(ms); queueMicrotask(fn); return 0; };
}

for (const target of ['chrome', 'firefox']) {
  test(`${target}: server accepts an event but its response is lost; retry reconciles without duplicates`, async () => {
    let loseResponse = true;
    const h = create(target, { fetch: async (url, init, { events }) => {
      const basic = oauth(url) ?? lectio(url);
      if (basic) return basic;
      if (init.method === 'POST' && new URL(url).pathname.endsWith('/events')) {
        const resource = JSON.parse(init.body);
        events.push(resource);
        if (loseResponse) { loseResponse = false; throw new TypeError('Network disconnected after server accepted write'); }
        return Response.json({ id: resource.id });
      }
      return Response.json({ items: events });
    } });
    await assert.rejects(h.api.runSync(true), error => error.calendarMayHaveChanged === true);
    assert.equal(h.events.length, 1);
    assert.equal(h.data[STATE_KEY].lastSuccessAt, undefined);
    assert.deepEqual(h.data[STATE_KEY].sourceSnapshots, {});
    const restarted = create(target, { fetch: async (url, init) => {
      const basic = oauth(url) ?? lectio(url);
      if (basic) return basic;
      assert.ok(!['POST', 'PUT', 'DELETE'].includes(init.method), 'restart must read existing event instead of writing another');
      return Response.json({ items: h.events });
    } });
    restarted.data[STATE_KEY] = structuredClone(h.data[STATE_KEY]);
    const result = await restarted.api.runSync(true);
    assert.equal(result.inserted, 0);
    assert.equal(result.unchanged, 1);
    assert.equal(restarted.data[STATE_KEY].status, 'healthy');
  });

  test(`${target}: 403 event-access denial preserves ownership and makes no calendar or event writes`, async () => {
    const h = create(target, { fetch: async url => oauth(url) ?? lectio(url)
      ?? Response.json({ error: { code: 403, message: 'insufficientPermissions' } }, { status: 403 }) });
    await assert.rejects(h.api.runSync(true), error => error.code === 'GOOGLE_API');
    assert.equal(h.data[ownershipKey], 'calendar');
    assert.equal(h.data[STATE_KEY].googleCalendarId, 'calendar');
    assert.equal(h.requests.some(r => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method) && r.url.includes('/calendar/v3/')), false);
  });

  test(`${target}: temporary rate limiting retries with bounded backoff and then succeeds`, async () => {
    const delays = [];
    let attempts = 0;
    const h = create(target, { setTimeout: immediateDelays(delays), fetch: async url => oauth(url)
      ?? (++attempts <= 3 ? Response.json({ error: { reason: 'userRateLimitExceeded' } }, { status: 429 }) : Response.json({ items: [] })) });
    assert.equal((await new h.api.GoogleCalendarAdapter().listManaged('calendar', window)).length, 0);
    assert.equal(attempts, 4);
    assert.deepEqual(delays, [350, 700, 1400]);
  });

  test(`${target}: persistent rate limiting stops after four attempts without reconnecting or replacing calendars`, async () => {
    const delays = [];
    let attempts = 0;
    const h = create(target, { setTimeout: immediateDelays(delays), fetch: async url => oauth(url)
      ?? (++attempts && Response.json({ error: { reason: 'rateLimitExceeded' } }, { status: 403 })) });
    await assert.rejects(new h.api.GoogleCalendarAdapter().ensureConnected(false, 'calendar'), error => error.status === 403);
    assert.equal(attempts, 4);
    assert.deepEqual(delays, [350, 700, 1400]);
    assert.equal(h.data[ownershipKey], 'calendar');
    assert.equal(h.requests.some(r => r.method === 'POST' && r.url.includes('/calendar/v3/')), false);
  });

  test(`${target}: failure on a later Google results page prevents every write and preserves sync history`, async () => {
    const history = { kept: { fingerprint: 'old', missingStreak: 1, lastSeenAt: '2026-09-01T00:00:00.000Z' } };
    const h = create(target, { state: { sourceSnapshots: history }, fetch: async (url) => {
      const basic = oauth(url) ?? lectio(url);
      if (basic) return basic;
      const parsed = new URL(url);
      if (parsed.searchParams.get('fields') === 'kind') return Response.json({ kind: 'calendar#events' });
      if (parsed.searchParams.has('pageToken')) throw new TypeError('Network lost on results page 2');
      return Response.json({ items: [], nextPageToken: 'page-2' });
    } });
    await assert.rejects(h.api.runSync(true));
    assert.deepEqual(h.data[STATE_KEY].sourceSnapshots, history);
    assert.equal(h.requests.some(r => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method) && r.url.includes('/calendar/v3/')), false);
    assert.equal(h.data[ownershipKey], 'calendar');
  });

  test(`${target}: a failed explicit connection does not poison the serialized connection queue`, async () => {
    let denied = true;
    const h = create(target, { fetch: async url => oauth(url) ?? (denied
      ? new Response('denied', { status: 403 }) : Response.json({ kind: 'calendar#events' })) });
    await assert.rejects(new h.api.GoogleCalendarAdapter().useExistingCalendar('recover@group.calendar.google.com', false));
    assert.equal(h.data[ownershipKey], 'calendar');
    denied = false;
    await new h.api.GoogleCalendarAdapter().useExistingCalendar('recover@group.calendar.google.com', false);
    assert.equal(h.data[ownershipKey], 'recover@group.calendar.google.com');
    assert.equal(h.requests.some(r => r.method === 'POST' && r.url.includes('/calendar/v3/')), false);
  });
}

test('Firefox: revoked refresh credential is removed without consent, event writes, or loss of calendar ownership', async () => {
  let interactive = 0;
  const h = create('firefox', {
    browserIdentity: { launchWebAuthFlow: async () => { interactive++; throw new Error('must not open'); } },
    fetch: async url => {
      assert.equal(url, 'https://oauth2.googleapis.com/token');
      return Response.json({ error: 'invalid_grant', error_description: 'Token has been revoked' }, { status: 400 });
    }
  });
  await assert.rejects(new h.api.GoogleCalendarAdapter().ensureConnected(false, 'calendar'), error => error.code === 'GOOGLE_AUTH_REQUIRED');
  assert.equal(h.data[refreshKey], undefined);
  assert.equal(h.data[ownershipKey], 'calendar');
  assert.equal(interactive, 0);
  assert.equal(h.requests.length, 1);
});

for (const target of ['chrome', 'firefox']) {
  test(`${target}: missing lessons need two valid observations; failed reads preserve history and returning lessons reset the count`, async () => {
    let mode = 'present';
    const missing = schedule.replace(/<a\b[^>]*>[\s\S]*?<\/a>/, '');
    const h = create(target, { fetch: async (url, init, { events }) => {
      const auth = oauth(url);
      if (auth) return auth;
      if (url.startsWith('https://www.lectio.dk')) {
        if (mode === 'network-error') throw new TypeError('Lectio unavailable');
        const response = new Response(url.includes('/aktivitet/') ? activity : mode === 'missing' ? missing : schedule);
        Object.defineProperty(response, 'url', { value: url });
        return response;
      }
      if (init.method === 'POST') {
        const resource = JSON.parse(init.body); events.push(resource); return Response.json({ id: resource.id });
      }
      if (init.method === 'DELETE') {
        events.splice(events.findIndex(e => e.id === new URL(url).pathname.split('/').at(-1)), 1);
        return new Response(null, { status: 204 });
      }
      return Response.json({ items: events });
    } });
    await h.api.runSync(true);
    assert.equal(h.events.length, 1);
    const sourceId = h.events[0].extendedProperties.private.sourceId;
    mode = 'missing';
    assert.equal((await h.api.runSync(true)).deleted, 0);
    assert.equal(h.data[STATE_KEY].sourceSnapshots[sourceId].missingStreak, 1);
    mode = 'network-error';
    await assert.rejects(h.api.runSync(true));
    assert.equal(h.data[STATE_KEY].sourceSnapshots[sourceId].missingStreak, 1);
    assert.equal(h.events.length, 1);
    mode = 'present';
    await h.api.runSync(true);
    assert.equal(h.data[STATE_KEY].sourceSnapshots[sourceId].missingStreak, 0);
    mode = 'missing';
    assert.equal((await h.api.runSync(true)).deleted, 0);
    assert.equal(h.events.length, 1);
    assert.equal((await h.api.runSync(true)).deleted, 1);
    assert.equal(h.events.length, 0);
  });

  test(`${target}: cancellation and reinstatement update the same event and restore busy status`, async () => {
    let cancelled = false;
    const h = create(target, { fetch: async (url, init, { events }) => {
      const auth = oauth(url);
      if (auth) return auth;
      if (url.startsWith('https://www.lectio.dk')) {
        const html = url.includes('/aktivitet/') ? activity : cancelled
          ? schedule.replace('class="s2skemabrik"', 'class="s2skemabrik cancelled"') : schedule;
        const response = new Response(html);
        Object.defineProperty(response, 'url', { value: url });
        return response;
      }
      if (init.method === 'POST') {
        const resource = JSON.parse(init.body); events.push(resource); return Response.json({ id: resource.id });
      }
      if (init.method === 'PUT') {
        const resource = JSON.parse(init.body); events[0] = resource; return Response.json({ id: resource.id });
      }
      return Response.json({ items: events });
    } });
    await h.api.runSync(true);
    const id = h.events[0].id;
    cancelled = true;
    assert.equal((await h.api.runSync(true)).updated, 1);
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0].id, id);
    assert.match(h.events[0].summary, /^AFLYST/);
    assert.equal(h.events[0].colorId, '11');
    assert.equal(h.events[0].transparency, 'transparent');
    cancelled = false;
    assert.equal((await h.api.runSync(true)).updated, 1);
    assert.equal(h.events[0].id, id);
    assert.doesNotMatch(h.events[0].summary, /^AFLYST/);
    assert.equal(h.events[0].transparency, 'opaque');
    assert.ok(h.events[0].colorId == null);
    assert.equal(h.requests.filter(r => r.method === 'POST' && r.url.includes('/calendar/v3/')).length, 1);
  });
}
