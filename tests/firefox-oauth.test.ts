import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  get: vi.fn(async (key: string) => ({ [key]: mocks.values[key] })),
  set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(mocks.values, value); }),
  remove: vi.fn(async (key: string) => { delete mocks.values[key]; }),
  getRedirectURL: vi.fn(() => "https://lectiosync-test.extensions.allizom.org/"),
  launchWebAuthFlow: vi.fn()
}));

vi.mock("webextension-polyfill", () => ({
  default: {
    storage: { local: { get: mocks.get, set: mocks.set, remove: mocks.remove } },
    identity: { getRedirectURL: mocks.getRedirectURL, launchWebAuthFlow: mocks.launchWebAuthFlow }
  }
}));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function loadModule() {
  vi.resetModules();
  return import("../src/core/firefox-oauth");
}

describe("Firefox Google OAuth", () => {
  beforeEach(() => {
    mocks.values = {};
    vi.clearAllMocks();
  });

  it("derives Firefox's provider-compatible loopback redirect safely", async () => {
    const { firefoxLoopbackRedirect, isValidFirefoxDesktopClientId } = await loadModule();
    expect(firefoxLoopbackRedirect("https://abc-123.extensions.allizom.org/path"))
      .toBe("http://127.0.0.1/mozoauth2/abc-123");
    expect(() => firefoxLoopbackRedirect("http://unsafe.example/test")).toThrow(/invalid OAuth redirect/i);
    expect(isValidFirefoxDesktopClientId("123456789012-real-client.apps.googleusercontent.com")).toBe(true);
    expect(isValidFirefoxDesktopClientId("test-firefox.apps.googleusercontent.com")).toBe(false);
    expect(isValidFirefoxDesktopClientId("REPLACE_WITH_FIREFOX_DESKTOP_OAUTH_CLIENT_ID.apps.googleusercontent.com")).toBe(false);
  });

  it("uses state and PKCE, stores only the refresh token, and revokes it on disconnect", async () => {
    mocks.launchWebAuthFlow.mockImplementationOnce(async ({ url }: { url: string }) => {
      const request = new URL(url);
      expect(request.origin).toBe("https://accounts.google.com");
      expect(request.searchParams.get("code_challenge_method")).toBe("S256");
      expect(request.searchParams.get("code_challenge")).toBeTruthy();
      expect(request.searchParams.get("redirect_uri")).toBe("http://127.0.0.1/mozoauth2/lectiosync-test");
      return `http://127.0.0.1/mozoauth2/lectiosync-test?code=authorization-code&state=${request.searchParams.get("state")}`;
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, {
        access_token: "access-one",
        refresh_token: "refresh-one",
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/calendar.app.created"
      }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const oauth = await loadModule();
    await expect(oauth.getFirefoxGoogleToken(true)).resolves.toBe("access-one");
    expect(mocks.values[oauth.FIREFOX_OAUTH_STORAGE_KEY]).toBe("refresh-one");
    const tokenBody = new URLSearchParams((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(tokenBody.get("code_verifier")?.length).toBeGreaterThanOrEqual(43);
    expect(tokenBody.get("client_secret")).toBe("unit-fixture-desktop-secret");

    await oauth.disconnectFirefoxGoogle();
    expect(mocks.values[oauth.FIREFOX_OAUTH_STORAGE_KEY]).toBeUndefined();
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("oauth2.googleapis.com/revoke");
  });

  it("refreshes without interaction after the background context restarts", async () => {
    const oauth = await loadModule();
    mocks.values[oauth.FIREFOX_OAUTH_STORAGE_KEY] = "stored-refresh";
    mocks.launchWebAuthFlow.mockRejectedValue(new Error("must not open"));
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(200, {
      access_token: "refreshed-access",
      expires_in: 3600,
      scope: "https://www.googleapis.com/auth/calendar.app.created"
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(oauth.getFirefoxGoogleToken(false)).resolves.toBe("refreshed-access");
    expect(mocks.launchWebAuthFlow).not.toHaveBeenCalled();
    const body = new URLSearchParams(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("stored-refresh");
    expect(body.get("client_secret")).toBe("unit-fixture-desktop-secret");
  });

  it("rejects a callback whose state does not match", async () => {
    mocks.launchWebAuthFlow.mockResolvedValue(
      "http://127.0.0.1/mozoauth2/lectiosync-test?code=authorization-code&state=attacker-state"
    );
    vi.stubGlobal("fetch", vi.fn());
    const oauth = await loadModule();
    await expect(oauth.getFirefoxGoogleToken(true)).rejects.toThrow(/state verification failed/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a callback from the wrong origin even when state matches", async () => {
    mocks.launchWebAuthFlow.mockImplementationOnce(async ({ url }: { url: string }) => {
      const request = new URL(url);
      return `https://attacker.example/callback?code=authorization-code&state=${request.searchParams.get("state")}`;
    });
    vi.stubGlobal("fetch", vi.fn());
    const oauth = await loadModule();
    await expect(oauth.getFirefoxGoogleToken(true)).rejects.toThrow(/invalid redirect URL/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("removes a refresh token whose storage write finishes after disconnect", async () => {
    mocks.launchWebAuthFlow.mockImplementationOnce(async ({ url }: { url: string }) => {
      const request = new URL(url);
      return `http://127.0.0.1/mozoauth2/lectiosync-test?code=authorization-code&state=${request.searchParams.get("state")}`;
    });
    const storageWrite = deferred<void>();
    mocks.set.mockImplementationOnce(async (value: Record<string, unknown>) => {
      await storageWrite.promise;
      Object.assign(mocks.values, value);
    });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, {
      access_token: "late-access",
      refresh_token: "late-refresh",
      expires_in: 3600,
      scope: "https://www.googleapis.com/auth/calendar.app.created"
    })));

    const oauth = await loadModule();
    const pending = oauth.getFirefoxGoogleToken(true);
    await vi.waitFor(() => expect(mocks.set).toHaveBeenCalledOnce());
    await oauth.disconnectFirefoxGoogle();
    storageWrite.resolve(undefined);

    await expect(pending).rejects.toThrow(/disconnected/i);
    expect(mocks.values[oauth.FIREFOX_OAUTH_STORAGE_KEY]).toBeUndefined();
    await expect(oauth.getFirefoxGoogleToken(false)).rejects.toThrow(/authentication is required/i);
  });

  it("does not cache a refreshed access token when disconnected during refresh", async () => {
    const oauth = await loadModule();
    mocks.values[oauth.FIREFOX_OAUTH_STORAGE_KEY] = "stored-refresh";
    const exchange = deferred<Response>();
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => exchange.promise)
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = oauth.getFirefoxGoogleToken(false);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await oauth.disconnectFirefoxGoogle();
    exchange.resolve(jsonResponse(200, {
      access_token: "late-refreshed-access",
      expires_in: 3600,
      scope: "https://www.googleapis.com/auth/calendar.app.created"
    }));

    await expect(pending).rejects.toThrow(/disconnected/i);
    expect(mocks.values[oauth.FIREFOX_OAUTH_STORAGE_KEY]).toBeUndefined();
    await expect(oauth.getFirefoxGoogleToken(false)).rejects.toThrow(/authentication is required/i);
  });

  it("starts interactive authorization separately from a failing silent refresh", async () => {
    const oauth = await loadModule();
    mocks.values[oauth.FIREFOX_OAUTH_STORAGE_KEY] = "stored-refresh";
    const silentExchange = deferred<Response>();
    mocks.launchWebAuthFlow.mockImplementationOnce(async ({ url }: { url: string }) => {
      const request = new URL(url);
      return `http://127.0.0.1/mozoauth2/lectiosync-test?code=authorization-code&state=${request.searchParams.get("state")}`;
    });
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => silentExchange.promise)
      .mockResolvedValueOnce(jsonResponse(400, { error: "invalid_grant" }))
      .mockResolvedValueOnce(jsonResponse(200, {
        access_token: "interactive-access",
        refresh_token: "interactive-refresh",
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/calendar.app.created"
      }));
    vi.stubGlobal("fetch", fetchMock);

    const silent = oauth.getFirefoxGoogleToken(false);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const interactive = oauth.getFirefoxGoogleToken(true);

    await expect(interactive).resolves.toBe("interactive-access");
    expect(mocks.launchWebAuthFlow).toHaveBeenCalledOnce();
    silentExchange.resolve(jsonResponse(400, { error: "invalid_grant" }));
    await expect(silent).rejects.toThrow(/invalid_grant/i);
  });
});
