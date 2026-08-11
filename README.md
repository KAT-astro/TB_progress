interface Env {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_DATA_REPO: string;
  GITHUB_DATA_PATH: string;
  GITHUB_DATA_BRANCH?: string;
  APP_ORIGIN: string;
  PUBLIC_URL: string;
  SESSION_SECRET: string;
}

type SessionPayload = { accessToken: string; expiresAt: number };
type GitHubFile = { content?: string; sha?: string; type?: string; message?: string };

const GITHUB_API = "https://api.github.com";
const OAUTH_STATE_COOKIE = "tb_progress_oauth_state";

function jsonResponse(data: unknown, status: number, env: Env) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=UTF-8",
    "Cache-Control": "no-store",
    ...corsHeaders(env),
  });
  return new Response(JSON.stringify(data), { status, headers });
}

function corsHeaders(env: Env) {
  return {
    "Access-Control-Allow-Origin": env.APP_ORIGIN,
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept",
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Vary": "Origin",
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "予期しないエラーが発生しました";
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sessionKey(secret: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptSession(payload: SessionPayload, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await sessionKey(secret);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(payload)));
  return `${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(encrypted))}`;
}

async function decryptSession(value: string, secret: string): Promise<SessionPayload | null> {
  try {
    const [ivPart, encryptedPart] = value.split(".");
    if (!ivPart || !encryptedPart) return null;
    const key = await sessionKey(secret);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64UrlDecode(ivPart) }, key, base64UrlDecode(encryptedPart));
    const payload = JSON.parse(new TextDecoder().decode(decrypted)) as SessionPayload;
    if (!payload.accessToken || payload.expiresAt <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function randomState() {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

function cookieValue(request: Request, name: string) {
  const cookies = request.headers.get("Cookie")?.split(";") ?? [];
  const cookie = cookies.map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : "";
}

function cookieHeader(name: string, value: string, maxAge: number) {
  return `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function htmlResponse(body: string, status = 200, extraHeaders: HeadersInit = {}) {
  return new Response(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui,sans-serif;padding:2rem;line-height:1.7">${body}</body></html>`, {
    status,
    headers: { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "no-store", ...extraHeaders },
  });
}

function scriptValue(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

function authResultPage(env: Env, session?: string, error?: string) {
  const message = error ? "GitHub接続に失敗しました。元の画面に戻って、もう一度お試しください。" : "GitHubに接続しました。この画面は閉じてください。";
  const payload = session ? `{ type: "tb-github-auth", session: ${scriptValue(session)} }` : `{ type: "tb-github-auth-error", message: ${scriptValue(error ?? "接続に失敗しました")} }`;
  return htmlResponse(`<p>${message}</p><script>const targetOrigin=${scriptValue(env.APP_ORIGIN)};const payload=${payload};if(window.opener){window.opener.postMessage(payload,targetOrigin);window.setTimeout(()=>window.close(),300)}</script>`);
}

async function githubRequest(path: string, token: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  headers.set("User-Agent", "TB-progress-GitHub-sync");
  return fetch(`${GITHUB_API}${path}`, { ...init, headers });
}

async function githubError(response: Response) {
  const body = await response.json().catch(() => ({})) as { message?: string };
  return body.message || `GitHub APIエラー（${response.status}）`;
}

function dataEndpoint(env: Env, includeBranch = true) {
  const [owner, repository] = env.GITHUB_DATA_REPO.split("/");
  if (!owner || !repository || !env.GITHUB_DATA_PATH) throw new Error("GitHub保存先の設定が不正です");
  const encodedPath = env.GITHUB_DATA_PATH.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const endpoint = new URL(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/contents/${encodedPath}`, GITHUB_API);
  if (includeBranch && env.GITHUB_DATA_BRANCH) endpoint.searchParams.set("ref", env.GITHUB_DATA_BRANCH);
  return endpoint.toString();
}

function decodeFileContent(value: string) {
  const binary = atob(value.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeFileContent(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

async function sessionFromRequest(request: Request, env: Env) {
  const authorization = request.headers.get("Authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const session = await decryptSession(match[1], env.SESSION_SECRET);
  return session?.accessToken ?? null;
}

async function handleMe(request: Request, env: Env) {
  const token = await sessionFromRequest(request, env);
  if (!token) return jsonResponse({ error: "GitHub接続が必要です" }, 401, env);
  const response = await githubRequest("/user", token);
  if (!response.ok) return jsonResponse({ error: await githubError(response) }, response.status, env);
  const user = await response.json() as { login: string; avatar_url?: string };
  return jsonResponse({ user: { login: user.login, avatar_url: user.avatar_url } }, 200, env);
}

async function handleData(request: Request, env: Env) {
  const token = await sessionFromRequest(request, env);
  if (!token) return jsonResponse({ error: "GitHub接続が必要です" }, 401, env);

  const readEndpoint = dataEndpoint(env, true);
  const writeEndpoint = dataEndpoint(env, false);
  if (request.method === "GET") {
    const response = await githubRequest(readEndpoint.replace(GITHUB_API, ""), token);
    if (response.status === 404) return jsonResponse({ exists: false, data: null }, 200, env);
    if (!response.ok) return jsonResponse({ error: await githubError(response) }, response.status, env);
    const file = await response.json() as GitHubFile;
    if (file.type && file.type !== "file" || !file.content) return jsonResponse({ error: "保存データのファイルを読み取れません" }, 422, env);
    try {
      return jsonResponse({ exists: true, data: JSON.parse(decodeFileContent(file.content)), sha: file.sha }, 200, env);
    } catch {
      return jsonResponse({ error: "保存データのJSONが壊れています" }, 422, env);
    }
  }

  if (request.method !== "PUT") return jsonResponse({ error: "この操作には対応していません" }, 405, env);
  const body = await request.json().catch(() => null) as { data?: unknown } | null;
  if (!body || !Object.prototype.hasOwnProperty.call(body, "data")) return jsonResponse({ error: "保存するデータがありません" }, 400, env);

  const currentResponse = await githubRequest(readEndpoint.replace(GITHUB_API, ""), token);
  let sha: string | undefined;
  if (currentResponse.ok) sha = (await currentResponse.json() as GitHubFile).sha;
  else if (currentResponse.status !== 404) return jsonResponse({ error: await githubError(currentResponse) }, currentResponse.status, env);

  const commitBody = {
    message: "Update study progress",
    content: encodeFileContent(`${JSON.stringify(body.data, null, 2)}\n`),
    ...(sha ? { sha } : {}),
    ...(env.GITHUB_DATA_BRANCH ? { branch: env.GITHUB_DATA_BRANCH } : {}),
  };
  const updateResponse = await githubRequest(writeEndpoint.replace(GITHUB_API, ""), token, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(commitBody) });
  if (!updateResponse.ok) return jsonResponse({ error: await githubError(updateResponse) }, updateResponse.status, env);
  const updated = await updateResponse.json() as { content?: { sha?: string } };
  return jsonResponse({ ok: true, sha: updated.content?.sha }, 200, env);
}

async function handleAuthStart(env: Env) {
  const state = randomState();
  const redirectUri = `${env.PUBLIC_URL.replace(/\/$/, "")}/auth/callback`;
  const query = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, redirect_uri: redirectUri, scope: "repo", state });
  return new Response(null, { status: 302, headers: { Location: `https://github.com/login/oauth/authorize?${query}`, "Set-Cookie": cookieHeader(OAUTH_STATE_COOKIE, state, 600) } });
}

async function handleAuthCallback(request: Request, env: Env, url: URL) {
  const state = url.searchParams.get("state") ?? "";
  const savedState = cookieValue(request, OAUTH_STATE_COOKIE);
  const clearCookie = cookieHeader(OAUTH_STATE_COOKIE, "", 0);
  if (!state || !savedState || state !== savedState) return authResultPage(env, undefined, "OAuthの確認に失敗しました");
  const code = url.searchParams.get("code");
  if (!code) return authResultPage(env, undefined, url.searchParams.get("error_description") ?? "GitHubの認証がキャンセルされました");

  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: `${env.PUBLIC_URL.replace(/\/$/, "")}/auth/callback` }),
  });
  const token = await response.json() as { access_token?: string; error_description?: string };
  if (!response.ok || !token.access_token) return new Response((await authResultPage(env, undefined, token.error_description ?? "アクセストークンの取得に失敗しました")).body, { status: 500, headers: { "Content-Type": "text/html; charset=UTF-8", "Set-Cookie": clearCookie } });

  const session = await encryptSession({ accessToken: token.access_token, expiresAt: Math.floor(Date.now() / 1000) + 8 * 60 * 60 }, env.SESSION_SECRET);
  const result = authResultPage(env, session);
  result.headers.set("Set-Cookie", clearCookie);
  return result;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(env) });
    if (url.pathname === "/health") return jsonResponse({ ok: true }, 200, env);
    try {
      if (url.pathname === "/auth/start" && request.method === "GET") return handleAuthStart(env);
      if (url.pathname === "/auth/callback" && request.method === "GET") return handleAuthCallback(request, env, url);
      if (url.pathname === "/api/me" && request.method === "GET") return handleMe(request, env);
      if (url.pathname === "/api/data") return handleData(request, env);
      return jsonResponse({ error: "Not found" }, 404, env);
    } catch (error) {
      return jsonResponse({ error: errorMessage(error) }, 500, env);
    }
  },
};
