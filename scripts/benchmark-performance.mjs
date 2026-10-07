import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { writeFile, mkdir } from 'node:fs/promises';
import { compileFixture, fixture, schedule, activity, account } from '../tests/helpers/performance-fixture.mjs';

const baselineRoot = process.argv[2];
const currentBundle = await compileFixture();
const baselineBundle = baselineRoot ? await compileFixture(baselineRoot) : undefined;
const current = fixture(currentBundle);
const baseline = baselineBundle ? fixture(baselineBundle) : undefined;
const largeActivity = `<div id="NiceFeaturesForAktivitetDialog">${'<section>'.repeat(40)}${Array.from({ length: 1000 }, (_, i) => `<p>Material ${i} with <b>nested text</b></p>`).join('')}${activity}${'</section>'.repeat(40)}</div>`;
const largeSchedule = schedule.replace('</td>', Array.from({ length: 39 }, (_, i) => schedule.match(/<a .*?<\/a>/)[0].replace('absid=123', 'absid=' + (124 + i))).join('') + '</td>');
const source = current.api.parseLectioSchedule(schedule).events[0];
const state = await current.api.getState();
const snapshots = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => ['absid:' + i, { fingerprint: 'abc', missingStreak: 0, lastSeenAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString() }]));

if (baseline) {
  const plain = value => JSON.parse(JSON.stringify(value));
  for (const html of [activity, largeActivity]) assert.deepEqual(plain(current.api.parseLectioActivityDetails(html)), plain(baseline.api.parseLectioActivityDetails(html)));
  for (let depth = 0; depth < 100; depth += 3) {
    for (const body of [activity, '<div><b>Titel:</b><p>Æble 🍎</p></div><div><b>Note:</b><p>Læs videre</p></div>', '<h1>30/9 1. modul - 3x - Algebra</h1><p>Læs side 4</p>']) {
      const html = '<section>'.repeat(depth) + body + '</section>'.repeat(depth);
      assert.deepEqual(plain(current.api.parseLectioActivityDetails(html)), plain(baseline.api.parseLectioActivityDetails(html)));
    }
  }
  assert.deepEqual(plain(current.api.parseLectioSchedule(largeSchedule)), plain(baseline.api.parseLectioSchedule(largeSchedule)));
  assert.deepEqual(plain(await current.api.toCalendarEvent(source, account, state.settings)), plain(await baseline.api.toCalendarEvent(source, account, state.settings)));
}

async function sample(work, iterations = 1) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) await work();
  return (performance.now() - start) / iterations;
}
function median(values) { return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]; }
const report = [];
async function measure(name, operation, iterations = 1) {
  for (let i = 0; i < 3; i++) { await sample(() => operation(currentBundle, current), iterations); if (baseline) await sample(() => operation(baselineBundle, baseline), iterations); }
  const before = [], after = [];
  for (let i = 0; i < 7; i++) {
    // Alternate order to reduce warmup/thermal bias.
    if (i % 2 && baseline) before.push(await sample(() => operation(baselineBundle, baseline), iterations));
    after.push(await sample(() => operation(currentBundle, current), iterations));
    if (!(i % 2) && baseline) before.push(await sample(() => operation(baselineBundle, baseline), iterations));
  }
  const result = { name, currentMs: median(after), ...(baseline ? { baselineMs: median(before), reductionPercent: (1 - median(after) / median(before)) * 100 } : {}) };
  report.push(result); console.log(JSON.stringify(result));
}
const currentStartup = await compileFixture('src', 'chrome', { startup: true });
const baselineStartup = baselineRoot ? await compileFixture(baselineRoot, 'chrome', { startup: true }) : undefined;
await measure('Background initialization', bundle => fixture(bundle === currentBundle ? currentStartup : baselineStartup), 20);
await measure('Small activity parse', (_, h) => h.api.parseLectioActivityDetails(activity), 100);
await measure('Nested 1000-paragraph activity parse', (_, h) => h.api.parseLectioActivityDetails(largeActivity), 10);
await measure('40-event schedule parse', (_, h) => h.api.parseLectioSchedule(largeSchedule), 50);
await measure('2000-snapshot storage patch', async bundle => { const h = fixture(bundle, { state: { sourceSnapshots: snapshots } }); await h.api.patchState({ status: 'ready' }); }, 10);
await measure('500-event conversion, cold immutable-ID cache', async bundle => {
  const h = fixture(bundle);
  const events = Array.from({ length: 500 }, (_, i) => ({ ...source, sourceId: 'absid:' + i }));
  if (h.api.mapConcurrent) await h.api.mapConcurrent(events, 16, event => h.api.toCalendarEvent(event, account, state.settings));
  else for (const event of events) await h.api.toCalendarEvent(event, account, state.settings);
});
await measure('500-event conversion, warm immutable-ID cache', async (_, h) => {
  const events = Array.from({ length: 500 }, (_, i) => ({ ...source, sourceId: 'absid:' + i }));
  if (h.api.mapConcurrent) await h.api.mapConcurrent(events, 16, event => h.api.toCalendarEvent(event, account, state.settings));
  else for (const event of events) await h.api.toCalendarEvent(event, account, state.settings);
});
await measure('13-week sync, one unique event, 15ms simulated Lectio latency', async bundle => {
  const h = fixture(bundle, { latency: 15, state: { settings: { horizonWeeks: 12 } } });
  await h.api.runSync(true);
});
await measure('13-week unchanged sync, 260 unique events, 15ms simulated Lectio latency', async (bundle, apiFixture) => {
  const weekValues = Array.from({ length: 13 }, (_, i) => apiFixture.api.lectioWeekValue(apiFixture.api.addWeeks(apiFixture.api.getIsoWeek(new Date()).monday, i)));
  const scheduleForWeek = week => schedule.replace(/<a .*?<\/a>/, Array.from({ length: 20 }, (_, i) => schedule.match(/<a .*?<\/a>/)[0].replace('absid=123', `absid=${week}${i}`)).join(''));
  const h = fixture(bundle, { state: { settings: { horizonWeeks: 12 } }, fetch: async url => {
    if (url.startsWith('https://www.lectio.dk')) {
      await new Promise(resolve => setTimeout(resolve, 15));
      return new Response(url.includes('/aktivitet/') ? activity : scheduleForWeek(new URL(url).searchParams.get('week')));
    }
    return Response.json({ id: 'calendar', items: h.events });
  } });
  for (const week of weekValues) {
    for (const event of h.api.parseLectioSchedule(scheduleForWeek(week)).events) {
      const input = await h.api.toCalendarEvent({ ...event, title: 'Matrices', note: 'Read chapter 2' }, account, state.settings);
      h.events.push(h.api.toGoogleResource(input));
    }
  }
  const summary = await h.api.runSync(true);
  assert.equal(summary.unchanged, 260);
});
await measure('Display date formatting', (_, h) => h.api.formatDisplayDateTime(new Date('2026-10-02T12:00:00Z')), 1000);
await mkdir('.build', { recursive: true });
await writeFile('.build/performance-results.json', JSON.stringify({ environment: { node: process.version, platform: process.platform, architecture: process.arch }, simulatedLatencyMs: 15, samples: 7, results: report }, null, 2) + '\n');
