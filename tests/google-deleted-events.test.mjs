import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileFixture, fixture, STATE_KEY } from './helpers/performance-fixture.mjs';

const bundle = await compileFixture();
const now = '2026-11-23T12:00:00.000Z';
const deleted = () => Response.json({ error: { errors: [{ domain: 'global', reason: 'deleted', message: 'Resource has been deleted' }], code: 410, message: 'Resource has been deleted' } }, { status: 410 });
const missing = { fingerprint: 'old', missingStreak: 1, lastSeenAt: now };

test('Deleted records absent from Lectio are not deleted again or retained in snapshots', () => {
  const h = fixture(bundle);
  const result = h.api.reconcileEvents([], [{ id: 'gone', sourceId: 'old', status: 'cancelled' }], { old: missing }, now);
  assert.equal(result.operations.length, 0);
  assert.equal(Object.keys(result.nextSnapshots).length, 0);
});

test('A live event is preferred over a deleted duplicate with the deterministic ID', () => {
  const h = fixture(bundle);
  const desired = { id: 'stable', sourceId: 'lesson', fingerprint: 'same' };
  const result = h.api.reconcileEvents([desired], [
    { ...desired, status: 'cancelled' },
    { ...desired, id: 'live', status: 'confirmed' },
    { ...desired, id: 'deleted-duplicate', status: 'cancelled' }
  ], {}, now);
  assert.equal(result.operations.length, 1);
  assert.equal(result.operations[0].kind, 'noop');
  assert.equal(result.operations[0].eventId, 'live');
});

test('A deleted lesson still present in Lectio can be restored', () => {
  const h = fixture(bundle);
  const desired = { id: 'stable', sourceId: 'lesson', fingerprint: 'same' };
  const result = h.api.reconcileEvents([desired], [{ ...desired, status: 'cancelled' }], {}, now);
  assert.equal(result.operations.length, 1);
  assert.equal(result.operations[0].kind, 'update');
  assert.equal(result.operations[0].eventId, 'stable');
});

test('A deletion racing with another deletion completes and remaining writes continue', async () => {
  const h = fixture(bundle, { fetch: async () => deleted() });
  const result = await new h.api.GoogleCalendarAdapter().apply('calendar', [
    { kind: 'delete', eventId: 'already-deleted', sourceId: 'old' },
    { kind: 'noop', eventId: 'kept', sourceId: 'kept' }
  ]);
  assert.equal(result.deleted, 1);
  assert.equal(result.unchanged, 1);
  assert.equal(h.requests.length, 1);
});

for (const status of [401, 403, 404, 500]) {
  test(`Deletion failure ${status} is still reported`, async () => {
    const h = fixture(bundle, { fetch: async () => new Response('failure', { status }) });
    await assert.rejects(new h.api.GoogleCalendarAdapter().apply('calendar', [
      { kind: 'delete', eventId: 'event', sourceId: 'lesson' }
    ]), error => error.status === status);
  });
}

test('410 on an update is not mistaken for a successful deletion', async () => {
  const h = fixture(bundle, { fetch: async () => deleted() });
  await assert.rejects(new h.api.GoogleCalendarAdapter().apply('calendar', [
    { kind: 'update', eventId: 'event', event: { id: 'event', sourceId: 'lesson' } }
  ]), error => error.status === 410);
});

test('A paused Chrome installation recovers and repeated syncs stay healthy with deleted records', async () => {
  let race = true;
  const h = fixture(bundle, {
    state: { status: 'error', sourceSnapshots: { old: missing } },
    fetch: async (url, init, { events }) => {
      if (url.startsWith('https://www.lectio.dk')) {
        const { schedule, activity } = await import('./helpers/performance-fixture.mjs');
        const response = new Response(url.includes('/aktivitet/') ? activity : schedule);
        Object.defineProperty(response, 'url', { value: url });
        return response;
      }
      if (init.method === 'DELETE') { race = false; return deleted(); }
      if (init.method === 'POST') {
        const resource = JSON.parse(init.body);
        events.push(resource);
        return Response.json({ id: resource.id });
      }
      return Response.json({ items: [
        ...events,
        { id: 'old-event', status: race ? 'confirmed' : 'cancelled', extendedProperties: { private: { sourceId: 'old', lectioSync: 'true', fingerprint: 'old' } } }
      ] });
    }
  });
  const first = await h.api.runSync(true);
  assert.equal(first.deleted, 1);
  assert.equal(first.inserted, 1);
  assert.equal(h.data[STATE_KEY].status, 'healthy');
  const second = await h.api.runSync(true);
  assert.equal(second.deleted, 0);
  assert.equal(second.inserted, 0);
  assert.equal(second.unchanged, 1);
  assert.equal(h.data[STATE_KEY].status, 'healthy');
  assert.equal(h.data[STATE_KEY].sourceSnapshots.old, undefined);
  assert.equal(h.requests.filter(r => r.method === 'DELETE').length, 1);
  assert.equal(h.events.length, 1);
});
