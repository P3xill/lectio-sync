const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";
const EXPIRY_SKEW_MS = 60_000;
const GOOGLE_CLIENT_ID_PATTERN = /^\d{6,}-[a-z0-9_-]+\.apps\.googleusercontent\.com$/iu;

interface CachedAccessToken {
  token: string;
  expiresAt: number;
}

interface BraveNavigator {
  brave?: { isBrave?: () => Promise<boolean> };
}

let cachedAccessToken: CachedAccessToken | undefined;
let interactiveTokenRequest: Promise<string> | undefined;
let nonInteractiveTokenRequest: Promise<string> | undefined;

export function isValidBraveWebClientId(clientId: string): boolean {
  return GOOGLE_CLIENT_ID_PATTERN.test(clientId);
}

export async function resolveBraveOAuthMode(
  mode: "auto" | "brave" | "chrome",
  navigatorValue: BraveNavigator | undefined
): Promise<boolean> {
  if (mode === "brave") return true;
  if (mode === "chrome") return false;
  const check = navigatorValue?.brave?.isBrave;
  if (!check) return false;
  try {
    return await check.call(navigatorValue.brave);
  } catch {
    return false;
  }
}

export async function isBraveBrowser(): Promise<boolean> {
  return resolveBraveOAuthMode(
    __CHROMIUM_OAUTH_MODE__,
    globalThis.navigator as BraveNavigator | undefined
  );
}

function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function braveRedirectUrl(): string {
  const redirect = chrome.identity.getRedirectURL();
  const url = new URL(redirect);
  const expectedHost = `${chrome.runtime.id}.chromiumapp.org`;
  if (url.protocol !== "https:" || url.hostname !== expectedHost || url.pathname !== "/") {
    throw new Error("Brave returned an invalid OAuth redirect URL.");
  }
  return url.toString();
}

async function authorize(interactive: boolean): Promise<string> {
  if (!isValidBraveWebClientId(__GOOGLE_BRAVE_OAUTH_CLIENT_ID__)) {
    throw new Error("Brave Google OAuth is not configured with a valid Web application client ID.");
  }
  if (!chrome.identity?.launchWebAuthFlow || !chrome.identity?.getRedirectURL) {
    throw new Error("Brave web authentication is unavailable.");
  }

  const state = randomState();
  const redirectUri = braveRedirectUrl();
  const authUrl = new URL(AUTH_ENDPOINT);
  authUrl.search = new URLSearchParams({
    client_id: __GOOGLE_BRAVE_OAUTH_CLIENT_ID__,
    redirect_uri: redirectUri,
    response_type: "token",
    scope: GOOGLE_CALENDAR_SCOPE,
    state,
    prompt: interactive ? "consent" : "none"
  }).toString();

  const resultUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive,
    ...(!interactive ? { abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 15_000 } : {})
  });
  if (!resultUrl) throw new Error("Google authorization was cancelled.");
  const result = new URL(resultUrl);
  if (result.origin !== new URL(redirectUri).origin || result.pathname !== "/") {
    throw new Error("Google OAuth returned an invalid redirect URL.");
  }
  const response = new URLSearchParams(result.hash.slice(1));
  if (response.get("state") !== state) throw new Error("Google OAuth state verification failed.");
  const oauthError = response.get("error");
  if (oauthError) throw new Error(`Google authorization failed: ${oauthError}`);
  const token = response.get("access_token");
  if (!token) throw new Error("Google authorization did not return an access token.");
  const grantedScopes = new Set((response.get("scope") ?? GOOGLE_CALENDAR_SCOPE).split(/\s+/u));
  if (!grantedScopes.has(GOOGLE_CALENDAR_SCOPE)) throw new Error("Google Calendar permission was not granted.");
  const expiresIn = Number(response.get("expires_in") ?? "3600");
  cachedAccessToken = {
    token,
    expiresAt: Date.now() + (Number.isFinite(expiresIn) ? Math.max(0, expiresIn) : 3600) * 1000
  };
  return token;
}

async function obtainToken(interactive: boolean): Promise<string> {
  if (cachedAccessToken && cachedAccessToken.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
    return cachedAccessToken.token;
  }
  return authorize(interactive);
}

export async function getBraveGoogleToken(interactive: boolean): Promise<string> {
  const pending = interactive ? interactiveTokenRequest : nonInteractiveTokenRequest;
  if (pending) return pending;

  const request = obtainToken(interactive).finally(() => {
    if (interactive) interactiveTokenRequest = undefined;
    else nonInteractiveTokenRequest = undefined;
  });
  if (interactive) interactiveTokenRequest = request;
  else nonInteractiveTokenRequest = request;
  return request;
}

export function invalidateBraveAccessToken(token: string): void {
  if (cachedAccessToken?.token === token) cachedAccessToken = undefined;
}

export async function disconnectBraveGoogle(): Promise<void> {
  const token = cachedAccessToken?.token;
  cachedAccessToken = undefined;
  if (!token) return;
  await fetch(REVOKE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
    cache: "no-store",
    referrerPolicy: "no-referrer"
  }).catch(() => undefined);
}

export const BRAVE_GOOGLE_CALENDAR_SCOPE = GOOGLE_CALENDAR_SCOPE;
