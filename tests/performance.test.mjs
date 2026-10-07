import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileFixture, fixture, STATE_KEY, schedule, activity, account } from './helpers/performance-fixture.mjs';

const chrome = await compileFixture();
const safari = await compileFixture('src', 'safari');
const plain = value => JSON.parse(JSON.stringify(value));

test('Bounded work preserves order, enforces its limit and drains after failure', async () => {
  const { api } = fixture(chrome);
  let active = 0, max = 0;
  const results = await api.mapConcurrent([4, 3, 2, 1], 2, async value => {
    active++; max = Math.max(max, active);
    await new Promise(resolve => setTimeout(resolve, value)); active--; return value * 2;
  });
  assert.deepEqual(plain(results), [8, 6, 4, 2]); assert.equal(max, 2);
  const started = [];
  await assert.rejects(api.mapConcurrent([0, 1, 2, 3], 2, async value => {
    started.push(value);
    if (value === 0) throw new Error('stop');
    active++; await new Promise(resolve => setTimeout(resolve, 10)); active--;
  }), /stop/);
  assert.deepEqual(started, [0, 1]); assert.equal(active, 0);
  await assert.rejects(api.mapConcurrent([], 0, async () => {}), /Invalid concurrency/);
});

test('Full sync overlaps at most four schedule reads, enriches and stays idempotent', async () => {
  const h = fixture(chrome, { latency: 5 });
  const first = await h.api.runSync(true);
  assert.equal(h.counts.maxActive, 4);
  assert.equal(first.inserted, 1); assert.equal(h.events[0].summary, 'Matrices');
  assert.match(h.events[0].description, /Read chapter 2/);
  assert.equal((await h.api.runSync(true)).unchanged, 1);
  assert.equal(h.events.length, 1);
  assert.equal(h.data[STATE_KEY].status, 'healthy');
});

test('Schedule failure drains other reads and starts no activity or calendar writes', async () => {
  let active = 0, started = 0;
  const h = fixture(chrome, { fetch: async url => {
    if (!url.startsWith('https://www.lectio.dk')) return Response.json({ id: 'calendar' });
    active++;
    try {
      if (++started === 1) { await new Promise(resolve => setTimeout(resolve, 1)); return new Response('Log ind med MitID'); }
      await new Promise(resolve => setTimeout(resolve, 10)); return new Response(schedule);
    } finally { active--; }
  } });
  await assert.rejects(h.api.runSync(true), error => error.code === 'LECTIO_AUTH_REQUIRED');
  assert.equal(active, 0); assert.equal(started, 4);
  assert.equal(h.requests.some(r => r.url.includes('/aktivitet/') || r.method === 'POST'), false);
});

test('Account changes during concurrent reads still prevent calendar mutation', async () => {
  const h = fixture(chrome, { fetch: async (url, init, { data }) => {
    if (url.startsWith('https://www.lectio.dk')) {
      data[STATE_KEY].lectioAccount.studentId = '99';
      return new Response(url.includes('/aktivitet/') ? activity : schedule);
    }
    return Response.json({ id: 'calendar', items: [] });
  } });
  await assert.rejects(h.api.runSync(true), error => /account or calendar changed/.test(error.message));
  assert.equal(h.requests.some(r => r.method === 'POST' || r.method === 'PUT' || r.method === 'DELETE'), false);
});

test('Safari shares tab discovery across reads and refreshes on preferred-tab failure', async () => {
  const h = fixture(safari);
  const fetchPage = h.api.createLectioPageFetcher();
  const url = 'https://www.lectio.dk/lectio/148/SkemaNy.aspx';
  await Promise.all(Array.from({ length: 8 }, () => fetchPage(url, 'no-store')));
  await fetchPage(url, 'no-store'); assert.equal(h.counts.tabs, 1);
  h.browser.tabs.sendMessage = async id => {
    if (id === 1) throw new Error('closed');
    return { status: 200, ok: true, type: 'basic', url, html: schedule };
  };
  h.browser.tabs.query = async () => { h.counts.tabs++; return [{ id: 2, url }]; };
  await fetchPage(url, 'no-store'); assert.equal(h.counts.tabs, 2);
  await fetchPage(url, 'no-store'); assert.equal(h.counts.tabs, 2);
  await h.api.createLectioPageFetcher()(url, 'no-store'); assert.equal(h.counts.tabs, 3);
});

test('Safari rejects untrusted responses and skips native calls for unchanged events', async () => {
  const h = fixture(safari, { sendMessage: async () => ({ status: 200, ok: true, type: 'basic', url: 'https://example.com/', html: schedule }) });
  await assert.rejects(h.api.createLectioPageFetcher()('https://www.lectio.dk/lectio/148/SkemaNy.aspx', 'no-store'), /signed-in Lectio tab/);
  const adapter = new h.api.SafariCalendarAdapter();
  const summary = await adapter.apply('calendar', [{ kind: 'noop', eventId: 'id', sourceId: 'absid:123' }]);
  assert.equal(summary.unchanged, 1); assert.equal(h.counts.native, 0);
  await adapter.apply('calendar', [{ kind: 'delete', eventId: 'id', sourceId: 'absid:123' }]);
  assert.equal(h.counts.native, 1);
});

test('Google projection retains pagination and concurrent reads share authentication', async () => {
  const h = fixture(chrome, { tokenLatency: 5, fetch: async url => {
    const query = new URL(url).searchParams;
    assert.equal(query.get('fields'), 'nextPageToken,items(id,status,extendedProperties/private)');
    return Response.json({ items: [{ id: query.get('pageToken') ?? 'first', status: 'confirmed', extendedProperties: { private: { sourceId: 'absid:123', fingerprint: 'abc', lectioStatus: 'changed' } } }], ...(query.has('pageToken') ? {} : { nextPageToken: 'second' }) });
  } });
  const adapter = new h.api.GoogleCalendarAdapter();
  const window = { timeMin: '2026-09-28T00:00:00Z', timeMax: '2026-10-05T00:00:00Z' };
  const [left, right] = await Promise.all([adapter.listManaged('calendar', window), adapter.listManaged('calendar', window)]);
  assert.deepEqual(plain(left), plain(right)); assert.equal(left.length, 2); assert.equal(left[1].lectioStatus, 'changed');
  assert.equal(h.counts.tokens, 2); assert.equal(h.requests.length, 4);
});

test('Parser preserves labels, composites, nested text, rejection limits and Unicode', () => {
  const { api } = fixture(chrome);
  assert.equal(api.parseLectioSchedule(schedule).events[0].title, 'Mathematics');
  assert.equal(api.parseLectioActivityDetails(activity).title, 'Matrices');
  const labels = '<div><b>Titel:</b><span>Æble <em>🍎</em></span></div><div><b>Note:</b><span>Læs videre</span></div>';
  assert.equal(api.parseLectioActivityDetails(labels).title, 'Æble 🍎');
  assert.equal(api.parseLectioActivityDetails(labels).note, 'Læs videre');
  const composite = '<div><h1>30/9 1. modul - 3x - Algebra</h1><p>Læs side 4</p><p>Lektier</p></div>';
  const parsed = api.parseLectioActivityDetails(composite);
  assert.equal(parsed.title, 'Algebra'); assert.equal(parsed.note, 'Læs side 4');
  assert.throws(() => api.parseLectioActivityDetails('<p>unknown</p>'), error => error.code === 'UNEXPECTED_PAGE');
  assert.throws(() => api.parseLectioSchedule('<table class="s2skema">' + '<div>'.repeat(201) + '</div>'.repeat(201) + '</table>'), error => error.code === 'UNEXPECTED_PAGE');
  assert.throws(() => api.parseLectioSchedule(schedule.replace('30/9-2026', '31/9-2026')), error => error.code === 'UNEXPECTED_PAGE');
});

test('Storage keeps the newest 2000 snapshots and patches with one sanitized write', async () => {
  const sourceSnapshots = Object.fromEntries(Array.from({ length: 2100 }, (_, i) => ['absid:' + i, { fingerprint: 'abc', missingStreak: 0, lastSeenAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString() }]));
  const h = fixture(chrome, { state: { sourceSnapshots } });
  const next = await h.api.patchState({ status: 'ready' });
  assert.equal(Object.keys(next.sourceSnapshots).length, 2000);
  assert.equal(next.sourceSnapshots['absid:0'], undefined);
  assert.ok(next.sourceSnapshots['absid:2099']); assert.equal(h.counts.sets, 1);
  assert.equal(next.lectioAccount.studentId, account.studentId);
});

test('Replacement snapshots are sanitized even though unchanged snapshots are reused', async () => {
  const h = fixture(chrome);
  const next = await h.api.patchState({ sourceSnapshots: {
    'absid:1': { fingerprint: 'abc', lastSeenAt: '2026-10-02T12:00:00Z', missingStreak: 8 },
    'absid:2': { fingerprint: 'abc', lastSeenAt: 'invalid', missingStreak: 0 },
    constructor: { fingerprint: 'abc', lastSeenAt: '2026-10-02T12:00:00Z', missingStreak: 0 }
  } });
  assert.deepEqual(Object.keys(next.sourceSnapshots), ['absid:1']);
  assert.equal(next.sourceSnapshots['absid:1'].missingStreak, 0);
});

test('Activity failure drains enrichment workers and stops further requests', async () => {
  let active = 0, started = 0;
  const bricks = Array.from({ length: 12 }, (_, i) => schedule.match(/<a .*?<\/a>/)[0].replace('absid=123', 'absid=' + (123 + i))).join('');
  const h = fixture(chrome, { state: { settings: { horizonWeeks: 2 } }, fetch: async url => {
    if (!url.startsWith('https://www.lectio.dk')) return Response.json({ id: 'calendar' });
    if (!url.includes('/aktivitet/')) return new Response(schedule.replace(/<a .*?<\/a>/, bricks));
    active++;
    try {
      if (++started === 1) { await new Promise(resolve => setTimeout(resolve, 1)); return new Response('Log ind med MitID'); }
      await new Promise(resolve => setTimeout(resolve, 10)); return new Response(activity);
    } finally { active--; }
  } });
  await assert.rejects(h.api.runSync(true), error => error.code === 'LECTIO_AUTH_REQUIRED');
  assert.equal(active, 0); assert.equal(started, 8);
  assert.equal(h.requests.some(r => r.method === 'POST'), false);
});

test('Concurrent sync callers share one run and an explicit full run queues once', async () => {
  const h = fixture(chrome, { latency: 5, state: {
    lastSuccessAt: '2026-10-01T00:00:00.000Z', fullSyncThrough: '2027-10-01T00:00:00.000Z', settings: { horizonWeeks: 12 }
  } });
  const periodic = h.api.runSync();
  assert.equal(h.api.runSync(), periodic);
  const full = h.api.runSync(true);
  assert.equal(h.api.runSync(true), full);
  assert.notEqual(periodic, full);
  await Promise.all([periodic, full]);
  const scheduleReads = h.requests.filter(r => r.url.includes('SkemaNy.aspx'));
  assert.equal(scheduleReads.length, 4 + 13);
  assert.equal(h.events.length, 1);
});

test('Response-size validation counts UTF-8 bytes and retains split Unicode chunks', async () => {
  const { api } = fixture(chrome);
  const bytes = new TextEncoder().encode('Læs 🍎');
  const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 6)); controller.enqueue(bytes.slice(6)); controller.close(); } });
  assert.equal(await api.readLimitedLectioText(new Response(stream)), 'Læs 🍎');
  await assert.rejects(api.readLimitedLectioText(new Response('x', { headers: { 'content-length': '2000001' } })), /too large/);
  await assert.rejects(api.readLimitedLectioText(new Response('🍎'.repeat(500001))), /too large/);
});

test('Disabling both activity fields skips unused activity requests', async () => {
  const h = fixture(chrome, { state: { settings: { horizonWeeks: 2, includeTitle: false, includeDescription: false } } });
  await h.api.runSync(true);
  assert.equal(h.requests.some(r => r.url.includes('/aktivitet/')), false);
  assert.equal(h.events[0].summary, '3x');
  assert.equal(h.events[0].description.includes('Description:'), false);
});

test('Google writes retain pacing, partial responses, and duplicate-ID recovery', async () => {
  const starts = [];
  let conflict = true;
  const h = fixture(chrome, { fetch: async (url, init) => {
    starts.push(Date.now());
    assert.equal(new URL(url).searchParams.get('fields'), 'id');
    if (init.method === 'POST' && conflict) { conflict = false; return new Response('duplicate', { status: 409 }); }
    return Response.json({ id: 'id' });
  } });
  const event = await h.api.toCalendarEvent(h.api.parseLectioSchedule(schedule).events[0], account, (await h.api.getState()).settings);
  const adapter = new h.api.GoogleCalendarAdapter();
  const summary = await adapter.apply('calendar', [{ kind: 'insert', event }, { kind: 'update', eventId: 'other', event }, { kind: 'noop', eventId: 'noop', sourceId: event.sourceId }]);
  assert.equal(summary.updated, 2); assert.equal(summary.unchanged, 1);
  assert.equal(h.requests.length, 3);
  const writes = h.requests.filter(r => r.method === 'POST' || r.url.includes('/other?'));
  assert.equal(writes.length, 2);
  assert.ok(starts[2] - starts[0] >= 150);
});

test('A missing Google calendar is recreated with projected creation response', async () => {
  const h = fixture(chrome, { state: { settings: { horizonWeeks: 2 } }, fetch: async (url, init) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'www.lectio.dk') return new Response(url.includes('/aktivitet/') ? activity : schedule);
    if (parsed.pathname.endsWith('/calendars/calendar')) return new Response('missing', { status: 404 });
    if (init.method === 'POST' && parsed.pathname.endsWith('/calendars')) {
      assert.equal(parsed.searchParams.get('fields'), 'id');
      return Response.json({ id: 'replacement' });
    }
    if (parsed.pathname.endsWith('/events') && init.method === 'POST') return Response.json({ id: JSON.parse(init.body).id });
    return Response.json({ id: 'replacement', items: [] });
  } });
  const summary = await h.api.runSync(true);
  assert.equal(summary.inserted, 1);
  assert.equal(h.data[STATE_KEY].googleCalendarId, 'replacement');
  assert.ok(h.requests.some(r => new URL(r.url).pathname.endsWith('/calendarList/replacement') && r.method === 'PATCH'));
});

test('Failed Google authentication is shared in flight and can be retried', async () => {
  let fail = true;
  const h = fixture(chrome, { tokenLatency: 5, fetch: async () => {
    if (fail) return new Response('unauthorized', { status: 401 });
    return Response.json({ items: [] });
  } });
  const adapter = new h.api.GoogleCalendarAdapter();
  const window = { timeMin: '2026-09-28T00:00:00Z', timeMax: '2026-10-05T00:00:00Z' };
  const failures = await Promise.allSettled([adapter.listManaged('calendar', window), adapter.listManaged('calendar', window)]);
  assert.equal(failures.every(r => r.status === 'rejected' && r.reason.status === 401), true);
  assert.equal(h.counts.tokens, 2);
  fail = false;
  await adapter.listManaged('calendar', window);
  assert.equal(h.counts.tokens, 3);
});

test('Immutable event-ID cache isolates accounts while fingerprints stay fresh', async () => {
  const { api } = fixture(chrome);
  const state = await api.getState();
  const source = api.parseLectioSchedule(schedule).events[0];
  const first = await api.toCalendarEvent(source, account, state.settings);
  const changed = await api.toCalendarEvent({ ...source, title: 'Changed title' }, account, state.settings);
  assert.equal(changed.id, first.id); assert.notEqual(changed.fingerprint, first.fingerprint);
  const other = await api.toCalendarEvent(source, { ...account, studentId: '99' }, state.settings);
  assert.notEqual(other.id, first.id);
  for (let i = 0; i < 2100; i++) await api.stableGoogleEventId('148', '42', 'absid:' + i);
  assert.equal(await api.stableGoogleEventId('148', '42', source.sourceId), first.id);
});

test('Safari response fast path still rejects pages exceeding the UTF-8 limit', async () => {
  const url = 'https://www.lectio.dk/lectio/148/SkemaNy.aspx';
  const h = fixture(safari, { sendMessage: async () => ({ status: 200, ok: true, type: 'basic', url, html: '🍎'.repeat(500001) }) });
  await assert.rejects(h.api.createLectioPageFetcher()(url, 'no-store'), /signed-in Lectio tab/);
  h.browser.tabs.sendMessage = async () => ({ status: 200, ok: true, type: 'basic', url, html: 'a'.repeat(750000) });
  assert.equal((await h.api.createLectioPageFetcher()(url, 'no-store')).html.length, 750000);
});

test('Snapshot timestamp memoization preserves validation and distinct last-seen dates', async () => {
  const h = fixture(chrome, { state: { sourceSnapshots: {
    'absid:1': { fingerprint: 'abc', missingStreak: 1, lastSeenAt: '2026-10-02T12:00:00Z' },
    'absid:2': { fingerprint: 'abc', missingStreak: 0, lastSeenAt: '2026-10-02T12:00:00Z' },
    'absid:3': { fingerprint: 'abc', missingStreak: 0, lastSeenAt: '2026-10-01T12:00:00Z' },
    'absid:4': { fingerprint: 'abc', missingStreak: 0, lastSeenAt: '2026-02-30T12:00:00Z' },
    'absid:5': { fingerprint: 'abc', missingStreak: 0, lastSeenAt: '2026-02-30T12:00:00Z' }
  } } });
  const full = await h.api.getState();
  assert.deepEqual(Object.keys(full.sourceSnapshots), ['absid:1', 'absid:2', 'absid:3']);
  assert.equal(full.sourceSnapshots['absid:1'].lastSeenAt, full.sourceSnapshots['absid:2'].lastSeenAt);
  assert.notEqual(full.sourceSnapshots['absid:1'].lastSeenAt, full.sourceSnapshots['absid:3'].lastSeenAt);
  const summary = await h.api.getStateSummary();
  assert.equal(Object.keys(summary.sourceSnapshots).length, 0);
  assert.equal(Object.keys(h.data[STATE_KEY].sourceSnapshots).length, 5);
});
