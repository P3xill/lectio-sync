import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

const result = await build({
  stdin: { contents: "export { withBackgroundActivity } from './src/core/background-activity';", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, format: 'iife', globalName: 'activity', platform: 'browser'
});
function harness() {
  let now = 0;
  let callback;
  let cleared = false;
  const context = vm.createContext({
    Date: { now: () => now },
    setInterval(fn, interval) { assert.equal(interval, 20_000); callback = fn; return 1; },
    clearInterval(id) { assert.equal(id, 1); cleared = true; }
  });
  vm.runInContext(result.outputFiles[0].text, context);
  return {
    run: context.activity.withBackgroundActivity,
    get cleared() { return cleared; },
    async tick(time) { now = time; if (!cleared) callback(); for (let i = 0; i < 8; i++) await Promise.resolve(); }
  };
}

test('Background activity spans a sync after its initiating view closes and is cleaned up on success', async () => {
  const h = harness();
  let finish;
  let pulses = 0;
  const operation = h.run(() => new Promise(resolve => { finish = resolve; }), async () => { pulses++; });
  await h.tick(20_000);
  await h.tick(40_000);
  assert.equal(pulses, 2);
  finish('synced');
  assert.equal(await operation, 'synced');
  assert.equal(h.cleared, true);
  await h.tick(60_000);
  assert.equal(pulses, 2);
});

test('Background activity does not overlap pending API calls and remains bounded if work hangs', async () => {
  const h = harness();
  let pulses = 0;
  void h.run(() => new Promise(() => {}), () => { pulses++; return new Promise(() => {}); });
  await h.tick(20_000);
  await h.tick(40_000);
  assert.equal(pulses, 1);
  await h.tick(600_000);
  assert.equal(h.cleared, true);
});

test('Failed syncs stop activity and a failed pulse does not change the sync outcome', async () => {
  const h = harness();
  let fail;
  const failure = new Error('sync failed');
  const operation = h.run(() => new Promise((resolve, reject) => { fail = reject; }), async () => { throw new Error('browser unavailable'); });
  await h.tick(20_000);
  fail(failure);
  await assert.rejects(operation, error => error === failure);
  assert.equal(h.cleared, true);
});
