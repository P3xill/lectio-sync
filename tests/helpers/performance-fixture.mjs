import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import { resolve } from 'node:path';

export const STATE_KEY = 'lectioSyncStateV1';
export const account = { schoolId: '148', studentId: '42', connectedAt: '2026-09-01T00:00:00.000Z' };
export const schedule = `<table class="s2skema"><tr><td data-date="2026-09-30"><a class="s2skemabrik" href="/lectio/148/aktivitet/aktivitetinfo2.aspx?absid=123" data-tooltip="Mathematics&#10;30/9-2026 08:00 til 09:00&#10;Hold: 3x">Mathematics</a></td></tr></table>`;
export const activity = `<div id="NiceFeaturesForAktivitetDialog"><h1 id="activity-title">Matrices</h1><p id="activity-note">Read chapter 2</p></div>`;

export async function compileFixture(root = 'src', target = 'chrome', options = {}) {
  const modules = ['parser', 'storage', 'calendar-event', 'calendar-adapter', 'crypto', 'google-calendar', 'safari-calendar', 'lectio-session', 'sync-engine', 'date'];
  if (root === 'src') modules.push('concurrency');
  const contents = options.startup ? `import ${JSON.stringify(resolve(root, "background.ts"))};` : modules.map((name, i) => `import * as m${i} from ${JSON.stringify(resolve(root, 'core', name + '.ts'))};`).join('\n')
    + `\nglobalThis.api = Object.assign({}, ${modules.map((_, i) => 'm' + i).join(',')});`;
  const bundle = await build({ stdin: { contents, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'iife', platform: 'browser', minify: Boolean(options.startup),
    define: { __TARGET_BROWSER__: JSON.stringify(target), __CHROMIUM_OAUTH_MODE__: JSON.stringify(options.oauthMode ?? 'chrome'), __GOOGLE_FIREFOX_OAUTH_CLIENT_ID__: '"fixture"', __GOOGLE_FIREFOX_OAUTH_CLIENT_SECRET__: '"fixture"', __GOOGLE_BRAVE_OAUTH_CLIENT_ID__: JSON.stringify(options.braveClientId ?? 'fixture') },
    plugins: [{ name: 'fixture', setup(build) {
      build.onResolve({ filter: /^webextension-polyfill$/ }, () => ({ path: 'browser', namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export default globalThis.testBrowser;', loader: 'js' }));
    } }]
  });
  return bundle.outputFiles[0].text;
}

export function fixture(bundle, options = {}) {
  const state = { status: 'healthy', lectioAccount: account, googleCalendarId: 'calendar', settings: { horizonWeeks: 8 }, sourceSnapshots: {}, ...options.state };
  const data = { [STATE_KEY]: structuredClone(state) };
  const counts = { tabs: 0, tokens: 0, gets: 0, sets: 0, native: 0, active: 0, maxActive: 0 };
  const requests = [];
  const events = [];
  const event = { addListener() {} };
  const browser = {
    storage: { local: {
      get: async () => { counts.gets++; return structuredClone(data); },
      set: async (values) => { counts.sets++; Object.assign(data, structuredClone(values)); },
      remove: async (key) => { delete data[key]; }
    } },
    tabs: {
      onRemoved: event, onUpdated: event,
      query: async () => { counts.tabs++; return options.tabs ?? [{ id: 1, url: 'https://www.lectio.dk/lectio/148/SkemaNy.aspx' }]; },
      sendMessage: async (id, message) => options.sendMessage ? options.sendMessage(id, message) : ({ status: 200, ok: true, type: 'basic', url: message.url, html: message.url.includes('/aktivitet/') ? activity : schedule })
    },
    alarms: { onAlarm: event, clear: async () => {}, create: async () => {} },
    notifications: { onClicked: event, create: async () => {} },
    runtime: { onMessage: event, onInstalled: event, onStartup: event, getURL: path => path, sendNativeMessage: async () => { counts.native++; return { ok: true, data: {} }; } }
  };
  const fetch = async (url, init = {}) => {
    url = String(url); requests.push({ url, ...init });
    if (options.fetch) return options.fetch(url, init, { data, counts, events });
    if (url.startsWith('https://www.lectio.dk')) {
      counts.active++; counts.maxActive = Math.max(counts.maxActive, counts.active);
      try {
        if (options.latency) await new Promise(resolve => setTimeout(resolve, options.latency));
        const response = new Response(url.includes('/aktivitet/') ? activity : schedule);
        Object.defineProperty(response, 'url', { value: url });
        return response;
      } finally { counts.active--; }
    }
    if (init.method === 'POST' && new URL(url).pathname.endsWith('/events')) {
      const resource = JSON.parse(init.body); events.push(resource); return Response.json({ id: resource.id });
    }
    if (url.includes('/events?')) return Response.json({ items: events });
    return Response.json({ id: 'calendar' });
  };
  const context = vm.createContext({ testBrowser: browser, chrome: {
    identity: { getAuthToken: async details => { counts.tokens++; if (options.tokenLatency) await new Promise(resolve => setTimeout(resolve, options.tokenLatency)); if (options.getAuthToken) return options.getAuthToken(details, counts.tokens); return { token: 'fixture-token' }; }, removeCachedAuthToken: async details => { if (options.removeCachedAuthToken) await options.removeCachedAuthToken(details); } },
    runtime: { id: 'fixture', getManifest: () => ({ oauth2: { client_id: '123456-test.apps.googleusercontent.com' } }) }
  }, fetch, Response, Headers, URL, URLSearchParams, TextEncoder, TextDecoder, crypto: webcrypto, atob, btoa, console, setTimeout, clearTimeout });
  if (options.chromeIdentity) Object.assign(context.chrome.identity, options.chromeIdentity);
  if (options.browserIdentity) browser.identity = options.browserIdentity;
  vm.runInContext(bundle, context);
  return { api: context.api, data, counts, requests, events, browser };
}
