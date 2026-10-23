const ACTIVITY_INTERVAL_MS = 20_000;
const MAX_ACTIVITY_MS = 10 * 60_000;

/** Keep finite network work active when an event page's originating view closes. */
export function withBackgroundActivity<T>(work: () => Promise<T>, pulse: () => Promise<unknown>): Promise<T> {
  const startedAt = Date.now();
  let pending = false;
  const timer = setInterval(() => {
    if (Date.now() - startedAt >= MAX_ACTIVITY_MS) {
      clearInterval(timer);
      return;
    }
    if (pending) return;
    pending = true;
    void Promise.resolve().then(pulse).catch(() => undefined).finally(() => { pending = false; });
  }, ACTIVITY_INTERVAL_MS);
  return Promise.resolve().then(work).finally(() => clearInterval(timer));
}
