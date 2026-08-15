import browser from "webextension-polyfill";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";
const REFRESH_TOKEN_KEY = "lectioSyncFirefoxGoogleRefreshTokenV1";
const EXPIRY_SKEW_MS = 60_000;
const DESKTOP_CLIENT_ID_PATTERN = /^\d{6,}-[a-z0-9_-]+\.apps\.googleusercontent\.com$/iu;

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface CachedAccessToken {
  token: string;
  expiresAt: number;
}

let cachedAccessToken: CachedAccessToken | undefined;
let interactiveTokenRequest: Promise<string> | undefined;
let nonInteractiveTokenRequest: Promise<string> | undefined;
let authorizationEpoch = 0;

function assertCurrentAuthorizationEpoch(epoch: number): void {
  if (epoch !== authorizationEpoch) {
    throw new Error("Google authorization was disconnected.");
  }
}

export function isValidFirefoxDesktopClientId(clientId: string): boolean {
  return DESKTOP_CLIENT_ID_PATTERN.test(clientId);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function randomBase64Url(byteLength = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export function firefoxLoopbackRedirect(identityRedirect: string): string {
  const url = new URL(identityRedirect);
  const subdomain = url.hostname.split(".")[0];
  if (url.protocol !== "https:" || !subdomain || !/^[a-z0-9-]+$/iu.test(subdomain)) {
    throw new Error("Firefox returned an invalid OAuth redirect URL.");
  }
  return `http://127.0.0.1/mozoauth2/${subdomain}`;
}

async function readRefreshToken(): Promise<string | undefined> {
  const stored = await browser.storage.local.get(REFRESH_TOKEN_KEY);
  const value = stored[REFRESH_TOKEN_KEY];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function storeRefreshToken(token: string, epoch: number): Promise<void> {
  assertCurrentAuthorizationEpoch(epoch);
  await browser.storage.local.set({ [REFRESH_TOKEN_KEY]: token });
  if (epoch !== authorizationEpoch) {
    await browser.storage.local.remove(REFRESH_TOKEN_KEY);
    assertCurrentAuthorizationEpoch(epoch);
  }
}

async function clearRefreshToken(): Promise<void> {
  cachedAccessToken = undefined;
  await browser.storage.local.remove(REFRESH_TOKEN_KEY);
}

async function tokenEndpoint(params: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    cache: "no-store",
    referrerPolicy: "no-referrer"
  });
  const body = await response.json().catch(() => ({})) as TokenResponse;
  if (!response.ok || !body.access_token) {
    const detail = body.error_description || body.error || `Google OAuth returned ${response.status}.`;
    throw new Error(detail.slice(0, 300));
  }
  return body;
}

function cacheToken(response: TokenResponse, epoch: number): string {
  assertCurrentAuthorizationEpoch(epoch);
  if (!response.access_token) throw new Error("Google OAuth did not return an access token.");
  const granted = new Set((response.scope ?? GOOGLE_CALENDAR_SCOPE).split(/\s+/u));
  if (!granted.has(GOOGLE_CALENDAR_SCOPE)) {
    throw new Error("Google Calendar permission was not granted.");
  }
  cachedAccessToken = {
    token: response.access_token,
    expiresAt: Date.now() + Math.max(0, response.expires_in ?? 3600) * 1000
  };
  return response.access_token;
}

async function refreshAccessToken(refreshToken: string, epoch: number): Promise<string> {
  try {
    const response = await tokenEndpoint(new URLSearchParams({
      client_id: __GOOGLE_FIREFOX_OAUTH_CLIENT_ID__,
      client_secret: __GOOGLE_FIREFOX_OAUTH_CLIENT_SECRET__,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    }));
    return cacheToken(response, epoch);
  } catch (error) {
    if (/invalid_grant|revoked|expired/i.test(String(error))) await clearRefreshToken();
    throw error;
  }
}

async function authorizeInteractively(epoch: number): Promise<string> {
  assertCurrentAuthorizationEpoch(epoch);
  if (!isValidFirefoxDesktopClientId(__GOOGLE_FIREFOX_OAUTH_CLIENT_ID__)) {
    throw new Error("Firefox Google OAuth is not configured with a valid Google Desktop client ID.");
  }
  const redirectUri = firefoxLoopbackRedirect(browser.identity.getRedirectURL());
  const verifier = randomBase64Url(64);
  const state = randomBase64Url(32);
  const authUrl = new URL(AUTH_ENDPOINT);
  authUrl.search = new URLSearchParams({
    client_id: __GOOGLE_FIREFOX_OAUTH_CLIENT_ID__,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_CALENDAR_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: await codeChallenge(verifier),
    code_challenge_method: "S256"
  }).toString();

  const resultUrl = await browser.identity.launchWebAuthFlow({ url: authUrl.toString(), interactive: true });
  assertCurrentAuthorizationEpoch(epoch);
  if (!resultUrl) throw new Error("Google authorization was cancelled.");
  const result = new URL(resultUrl);
  const expectedRedirect = new URL(redirectUri);
  if (result.origin !== expectedRedirect.origin || result.pathname !== expectedRedirect.pathname) {
    throw new Error("Google OAuth returned an invalid redirect URL.");
  }
  if (result.searchParams.get("state") !== state) throw new Error("Google OAuth state verification failed.");
  const oauthError = result.searchParams.get("error");
  if (oauthError) throw new Error(`Google authorization failed: ${oauthError}`);
  const code = result.searchParams.get("code");
  if (!code) throw new Error("Google authorization did not return a code.");

  const response = await tokenEndpoint(new URLSearchParams({
    client_id: __GOOGLE_FIREFOX_OAUTH_CLIENT_ID__,
    client_secret: __GOOGLE_FIREFOX_OAUTH_CLIENT_SECRET__,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    grant_type: "authorization_code"
  }));
  assertCurrentAuthorizationEpoch(epoch);
  if (!response.refresh_token) throw new Error("Google OAuth did not return a refresh token.");
  await storeRefreshToken(response.refresh_token, epoch);
  return cacheToken(response, epoch);
}

async function obtainToken(interactive: boolean, epoch: number): Promise<string> {
  assertCurrentAuthorizationEpoch(epoch);
  if (cachedAccessToken && cachedAccessToken.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
    return cachedAccessToken.token;
  }
  const refreshToken = await readRefreshToken();
  assertCurrentAuthorizationEpoch(epoch);
  if (refreshToken) {
    try {
      return await refreshAccessToken(refreshToken, epoch);
    } catch (error) {
      if (!interactive) throw error;
    }
  }
  if (!interactive) throw new Error("Google authentication is required.");
  return authorizeInteractively(epoch);
}

export async function getFirefoxGoogleToken(interactive: boolean): Promise<string> {
  const pending = interactive ? interactiveTokenRequest : nonInteractiveTokenRequest;
  if (pending) return pending;

  const epoch = authorizationEpoch;
  const request = obtainToken(interactive, epoch).finally(() => {
    if (interactive && interactiveTokenRequest === request) interactiveTokenRequest = undefined;
    if (!interactive && nonInteractiveTokenRequest === request) nonInteractiveTokenRequest = undefined;
  });
  if (interactive) interactiveTokenRequest = request;
  else nonInteractiveTokenRequest = request;
  return request;
}

export function invalidateFirefoxAccessToken(token: string): void {
  if (cachedAccessToken?.token === token) cachedAccessToken = undefined;
}

export async function disconnectFirefoxGoogle(): Promise<void> {
  authorizationEpoch += 1;
  interactiveTokenRequest = undefined;
  nonInteractiveTokenRequest = undefined;
  const refreshToken = await readRefreshToken();
  const accessToken = cachedAccessToken?.token;
  await clearRefreshToken();
  const token = refreshToken ?? accessToken;
  if (!token) return;
  await fetch(REVOKE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
    cache: "no-store",
    referrerPolicy: "no-referrer"
  }).catch(() => undefined);
}

export const FIREFOX_OAUTH_STORAGE_KEY = REFRESH_TOKEN_KEY;
