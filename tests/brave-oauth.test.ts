import { beforeEach, describe, expect, it, vi } from "vitest";

const extensionId = "ahipjdmmhiflgdpdhfakhhdmgocdphlf";
const redirectUri = `https://${extensionId}.chromiumapp.org/`;
const launchWebAuthFlow = vi.fn();
const getRedirectURL = vi.fn(() => redirectUri);

async function loadModule() {
  vi.resetModules();
  return import("../src/core/brave-oauth");
}

describe("Brave Google OAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("navigator", { brave: { isBrave: vi.fn(async () => true) } });
    vi.stubGlobal("chrome", {
      identity: { getRedirectURL, launchWebAuthFlow },
      runtime: { id: extensionId }
    });
  });

  it("detects Brave and validates its browser-owned redirect", async () => {
    const oauth = await loadModule();
    await expect(oauth.isBraveBrowser()).resolves.toBe(true);
    await expect(oauth.resolveBraveOAuthMode("brave", undefined)).resolves.toBe(true);
    await expect(oauth.resolveBraveOAuthMode("chrome", { brave: { isBrave: vi.fn(async () => true) } })).resolves.toBe(false);
    await expect(oauth.resolveBraveOAuthMode("auto", undefined)).resolves.toBe(false);
    expect(oauth.braveRedirectUrl()).toBe(redirectUri);
    expect(oauth.isValidBraveWebClientId("123456789012-valid.apps.googleusercontent.com")).toBe(true);
    expect(oauth.isValidBraveWebClientId("REPLACE_WITH_BRAVE_WEB_OAUTH_CLIENT_ID.apps.googleusercontent.com")).toBe(false);
  });

  it("uses a state-protected implicit flow and revokes the access token", async () => {
    launchWebAuthFlow.mockImplementationOnce(async ({ url, interactive }: { url: string; interactive: boolean }) => {
      expect(interactive).toBe(true);
      const request = new URL(url);
      expect(request.origin).toBe("https://accounts.google.com");
      expect(request.searchParams.get("redirect_uri")).toBe(redirectUri);
      expect(request.searchParams.get("response_type")).toBe("token");
      const state = request.searchParams.get("state");
      return `${redirectUri}#access_token=brave-access&expires_in=3600&scope=${encodeURIComponent("https://www.googleapis.com/auth/calendar.app.created")}&state=${state}`;
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const oauth = await loadModule();
    await expect(oauth.getBraveGoogleToken(true)).resolves.toBe("brave-access");
    await oauth.disconnectBraveGoogle();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("oauth2.googleapis.com/revoke");
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain("brave-access");
  });

  it.each([true, false])("deduplicates concurrent requests in the same interaction mode", async (interactive) => {
    let resolveAuthorization: ((resultUrl: string) => void) | undefined;
    launchWebAuthFlow.mockImplementationOnce(({ url }: { url: string }) => new Promise<string>((resolve) => {
      const state = new URL(url).searchParams.get("state");
      resolveAuthorization = (resultUrl) => resolve(`${resultUrl}&state=${state}`);
    }));

    const oauth = await loadModule();
    const first = oauth.getBraveGoogleToken(interactive);
    const second = oauth.getBraveGoogleToken(interactive);

    expect(launchWebAuthFlow).toHaveBeenCalledOnce();
    expect(launchWebAuthFlow.mock.calls[0]?.[0]).toMatchObject({ interactive });
    resolveAuthorization?.(
      `${redirectUri}#access_token=shared-token&expires_in=3600&scope=${encodeURIComponent("https://www.googleapis.com/auth/calendar.app.created")}`
    );
    await expect(Promise.all([first, second])).resolves.toEqual(["shared-token", "shared-token"]);
  });

  it("starts an interactive request instead of joining a pending silent failure", async () => {
    let resolveSilent: ((resultUrl: string) => void) | undefined;
    launchWebAuthFlow.mockImplementation(({ url, interactive }: { url: string; interactive: boolean }) => {
      const state = new URL(url).searchParams.get("state");
      if (!interactive) {
        return new Promise<string>((resolve) => {
          resolveSilent = (resultUrl) => resolve(`${resultUrl}&state=${state}`);
        });
      }
      return Promise.resolve(
        `${redirectUri}#access_token=interactive-token&expires_in=3600&scope=${encodeURIComponent("https://www.googleapis.com/auth/calendar.app.created")}&state=${state}`
      );
    });

    const oauth = await loadModule();
    const silent = oauth.getBraveGoogleToken(false);
    const interactive = oauth.getBraveGoogleToken(true);

    await expect(interactive).resolves.toBe("interactive-token");
    expect(launchWebAuthFlow.mock.calls.map(([details]) => details.interactive)).toEqual([false, true]);

    resolveSilent?.(`${redirectUri}#error=login_required`);
    await expect(silent).rejects.toThrow(/login_required/i);
  });

  it("rejects forged state and redirect responses", async () => {
    launchWebAuthFlow.mockResolvedValueOnce(`${redirectUri}#access_token=stolen&state=attacker`);
    const oauth = await loadModule();
    await expect(oauth.getBraveGoogleToken(true)).rejects.toThrow(/state verification failed/i);

    launchWebAuthFlow.mockResolvedValueOnce("https://attacker.example/#access_token=stolen");
    await expect(oauth.getBraveGoogleToken(true)).rejects.toThrow(/invalid redirect/i);
  });

  it("fails closed when Brave returns a callback for another extension", async () => {
    getRedirectURL.mockReturnValueOnce("https://other.chromiumapp.org/");
    const oauth = await loadModule();
    expect(() => oauth.braveRedirectUrl()).toThrow(/invalid OAuth redirect/i);
  });
});
