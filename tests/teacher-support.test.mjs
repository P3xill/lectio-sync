import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';
import { compileFixture, fixture, STATE_KEY, schedule, activity, account } from './helpers/performance-fixture.mjs';

const teacher = { schoolId: '148', teacherId: '42', connectedAt: account.connectedAt };
const accountBundle = await build({ entryPoints: ['src/core/account.ts'], bundle: true, write: false, format: 'iife', globalName: 'accountApi' });
const context = vm.createContext({ URL });
vm.runInContext(accountBundle.outputFiles[0].text, context);
const api = context.accountApi;
const url = query => `https://www.lectio.dk/lectio/148/SkemaNy.aspx?${query}`;
const doc = (baseURI, links = []) => ({ baseURI, querySelectorAll: () => links.map(([href, textContent]) => ({ href, textContent })) });

test('Detect teacher and student schedules, prefer personal navigation, ignore unrelated IDs', () => {
  assert.equal(api.accountFromDocument(doc(url('type=laerer&laererid=42'))).teacherId, '42');
  assert.equal(api.accountFromDocument(doc(url('TYPE=LAERER&LAERERID=42'))).teacherId, '42');
  assert.equal(api.accountFromDocument(doc(url('type=elev&elevid=42'))).studentId, '42');
  assert.equal(api.accountFromDocument(doc(url('type=elev&elevid=99'), [[url('type=laerer&laererid=42'), 'Skema']])).teacherId, '42');
  assert.equal(api.accountFromDocument(doc('https://www.lectio.dk/lectio/148/default.aspx', [[url('laererid=99'), 'Another teacher']])), undefined);
  for (const query of ['laererid=abc', 'elevid=42&laererid=42', 'type=elev&laererid=42']) {
    assert.equal(api.accountFromDocument(doc(url(query))), undefined);
  }
  assert.equal(api.accountFromDocument(doc(url(''), [['https://www.lectio.dk/lectio/999/SkemaNy.aspx?laererid=42', 'Skema']])), undefined);
});

test('A biology student keeps her personal identity while viewing a physics classmate or student list', () => {
  const links = [[url('type=elev&elevid=99'), 'Classmate with physics'], [url('type=elev&elevid=42'), 'Skema']];
  assert.equal(api.accountFromDocument(doc(url('type=elev&elevid=99'), links)).studentId, '42');
  assert.equal(api.accountFromDocument(doc('https://www.lectio.dk/lectio/148/elever.aspx', links)).studentId, '42');
  assert.equal(api.accountFromDocument(doc('https://www.lectio.dk/lectio/148/elever.aspx', links.slice(0, 1))), undefined);
});

for (const target of ['chrome', 'firefox']) {
  const bundle = await compileFixture('src', target);
  test(`${target}: teacher identity persists and event IDs stay distinct from existing student IDs`, async () => {
    const h = fixture(bundle, { state: { lectioAccount: teacher } });
    assert.equal((await h.api.getState()).lectioAccount.teacherId, '42');
    const settings = (await h.api.getState()).settings;
    const source = h.api.parseLectioSchedule(schedule).events[0];
    const studentEvent = await h.api.toCalendarEvent(source, account, settings);
    const teacherEvent = await h.api.toCalendarEvent(source, teacher, settings);
    assert.equal(studentEvent.id, await h.api.stableGoogleEventId('148', '42', source.sourceId));
    assert.notEqual(studentEvent.id, teacherEvent.id);
    h.data[STATE_KEY].lectioAccount = { ...teacher, studentId: '42' };
    assert.equal((await h.api.getState()).lectioAccount, undefined);
  });

  test(`${target}: teacher timetable moves, cancellation and reinstatement update one Google event`, async () => {
    let phase = 'original';
    const h = fixture(bundle, { state: { lectioAccount: teacher }, fetch: async (raw, init, { events }) => {
      if (raw === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'fixture', expires_in: 3600 });
      if (raw.startsWith('https://www.lectio.dk')) {
        const parsed = new URL(raw);
        if (!raw.includes('/aktivitet/')) {
          assert.equal(parsed.searchParams.get('type'), 'laerer');
          assert.equal(parsed.searchParams.get('laererid'), '42');
          assert.equal(parsed.searchParams.has('elevid'), false);
        }
        let html = raw.includes('/aktivitet/') ? activity : schedule;
        if (phase !== 'original') html = html.replace('08:00 til 09:00', '10:00 til 11:00');
        if (phase === 'cancelled') html = html.replace('Mathematics&#10;', 'Aflyst!&#10;Mathematics&#10;');
        const response = new Response(html);
        Object.defineProperty(response, 'url', { value: raw });
        return response;
      }
      if (init.method === 'POST' || init.method === 'PUT') {
        const resource = JSON.parse(init.body);
        if (init.method === 'POST') events.push(resource); else events[0] = resource;
        return Response.json({ id: resource.id });
      }
      return Response.json({ items: events });
    } });
    h.data.lectioSyncFirefoxGoogleRefreshTokenV1 = 'fixture-refresh';
    h.data.lectioSyncOwnedGoogleCalendarV1 = 'calendar';
    assert.equal((await h.api.runSync(true)).inserted, 1);
    const id = h.events[0].id, start = h.events[0].start.dateTime;
    phase = 'moved';
    assert.equal((await h.api.runSync(true)).updated, 1);
    assert.notEqual(h.events[0].start.dateTime, start);
    assert.equal(h.events[0].id, id);
    phase = 'cancelled';
    assert.equal((await h.api.runSync(true)).updated, 1);
    assert.match(h.events[0].summary, /^AFLYST/);
    assert.equal(h.events[0].transparency, 'transparent');
    phase = 'reinstated';
    assert.equal((await h.api.runSync(true)).updated, 1);
    assert.equal(h.events[0].transparency, 'opaque');
    assert.equal(h.events[0].id, id);
    assert.equal(h.events.length, 1);
    assert.equal(h.requests.filter(r => r.method === 'POST' && r.url.includes('/calendar/v3/')).length, 1);
  });
}
