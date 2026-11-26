import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileFixture, fixture, STATE_KEY } from './helpers/performance-fixture.mjs';

const bundle = await compileFixture();
const brick = (visible = '23 Bi-v/2 • AA • 30', title = '') => `<table class="s2skema"><tr><td data-date="2026-12-01"><a class="s2skemabrik" href="/lectio/148/aktivitet/aktivitetinfo2.aspx?absid=123" data-tooltip="3 FY-v • CH • 35&#10;1/12-2026 12:00 til 13:25&#10;Hold: 3 FY-v&#10;Lærer: CH&#10;Lokale: 35"><div class="s2skemabrikcontent">${visible}${title ? `<br>${title}` : ''}</div></a></td></tr></table>`;
const activity = '<div id="NiceFeaturesForAktivitetDialog"><div><b>Hold:</b><span>3 FY-v</span></div><h1 id="activity-title">Physics</h1><p id="activity-note">Wrong hold note</p></div>';

test('Visible biology hold, teacher and room override stale physics tooltip together', () => {
  const { api } = fixture(bundle);
  const event = api.parseLectioSchedule(brick()).events[0];
  assert.equal(event.title, '23 Bi-v/2 • AA • 30');
  assert.equal(event.className, '23 Bi-v/2');
  assert.equal(event.teacher, 'AA');
  assert.equal(event.location, '30');
  assert.equal(event.start, '2026-12-01T12:00:00');
  assert.equal(event.sourceId, 'absid:123');
  assert.equal(api.parseLectioSchedule(brick(undefined, 'Celler og DNA')).events[0].title, 'Celler og DNA');
  assert.equal(api.parseLectioSchedule(brick('23 Bi-v/2 · AA · 30')).events[0].teacher, 'AA');
});

test('Free-text activities retain tooltip metadata when no structured visible row exists', () => {
  const { api } = fixture(bundle);
  assert.equal(api.parseLectioSchedule(brick('A general activity')).events[0].className, '3 FY-v');
});

for (const changedId of [false, true]) {
  test(`Biology replaces synced physics ${changedId ? 'after the source ID changes' : 'in the existing event'} and repeat sync is idempotent`, async () => {
    let phase = 'physics';
    const h = fixture(bundle, { fetch: async (url, init, { events }) => {
      if (url.startsWith('https://www.lectio.dk')) {
        let html = url.includes('/aktivitet/') ? activity : phase === 'physics' ? brick('3 FY-v • CH • 35') : brick();
        if (changedId && phase !== 'physics') html = html.replace('absid=123', 'absid=456');
        const response = new Response(html);
        Object.defineProperty(response, 'url', { value: url });
        return response;
      }
      if (init.method === 'POST' || init.method === 'PUT') {
        const resource = JSON.parse(init.body);
        const index = events.findIndex(event => event.id === resource.id);
        if (index < 0) events.push(resource); else events[index] = resource;
        return Response.json(resource);
      }
      if (init.method === 'DELETE') {
        const index = events.findIndex(event => url.endsWith('/' + event.id));
        if (index >= 0) events.splice(index, 1);
        return new Response(null, { status: 204 });
      }
      return Response.json({ id: 'calendar', items: events });
    } });
    await h.api.runSync(true);
    const originalId = h.events[0].id;
    assert.equal(h.events[0].summary, 'Physics');
    phase = 'biology';
    await h.api.runSync(true);
    await h.api.runSync(true);
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0].summary, '23 Bi-v/2 • AA • 30');
    assert.match(h.events[0].description, /Class: 23 Bi-v\/2/);
    assert.match(h.events[0].description, /Teacher: AA/);
    assert.doesNotMatch(h.events[0].description, /Wrong hold note|3 FY-v/);
    assert.equal(h.events[0].location, '30');
    if (!changedId) assert.equal(h.events[0].id, originalId);
    const repeat = await h.api.runSync(true);
    assert.equal(repeat.inserted, 0);
    assert.equal(repeat.updated, 0);
    assert.equal(repeat.deleted, 0);
    assert.equal(h.data[STATE_KEY].status, 'healthy');
  });
}

for (const mismatch of ['elevid=99', 'week=012027', 'type=klasse', 'school', 'activity']) {
  test(`A response for another timetable/activity stops before calendar writes: ${mismatch}`, async () => {
    const h = fixture(bundle, { fetch: async (url) => {
      if (!url.startsWith('https://www.lectio.dk')) return Response.json({ id: 'calendar', items: [] });
      const returned = new URL(url);
      const isActivity = url.includes('/aktivitet/');
      if (mismatch === 'activity' && isActivity) returned.searchParams.set('absid', '999');
      else if (mismatch === 'school') returned.pathname = returned.pathname.replace('/148/', '/999/');
      else if (mismatch !== 'activity') {
        const [key, value] = mismatch.split('='); returned.searchParams.set(key, value);
      }
      const response = new Response(isActivity ? activity : brick());
      Object.defineProperty(response, 'url', { value: returned.href });
      return response;
    } });
    await assert.rejects(h.api.runSync(true), error => error.code === 'LECTIO_UNEXPECTED_PAGE');
    assert.equal(h.requests.some(request => ['POST', 'PUT', 'DELETE'].includes(request.method)), false);
  });
}
