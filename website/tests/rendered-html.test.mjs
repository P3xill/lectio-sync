import assert from "node:assert/strict";
import test from "node:test";

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${path}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }), {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  }, { waitUntil() {}, passThroughOnException() {} });
}

test("renders the finished product page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Lectio Sync/);
  assert.match(html, /Your timetable/);
  assert.match(html, /No ads/);
  assert.match(html, /Chrome/);
  assert.match(html, /Safari/);
  assert.doesNotMatch(html, /codex-preview|loading skeleton/i);
});

test("renders durable privacy and support pages", async () => {
  const privacy = await (await render("/privacy")).text();
  const support = await (await render("/support")).text();
  assert.match(privacy, /no analytics/i);
  assert.match(privacy, /Firefox only/i);
  assert.match(support, /Report a problem/i);
  assert.match(support, /Edge and Opera are not supported/i);
});
