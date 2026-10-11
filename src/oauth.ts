import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv } from './types';
import { body, boundedBody } from './http';
import { digest, newKey } from './security';
import { session, sessionPrincipal } from './web-auth';
import { accessLifetime, grantLifetime, expiresIn, oauthSecret, oauthScopes, grantIdentity, resourceUri } from './oauth-security';

class OAuthError extends Error {
  constructor(public code: string, message: string, public status: 400 | 401 | 403 | 429 = 400) { super(message); }
}
type Client = { id: string; name: string; redirect_uris: string; grant_types: string };
type Authorization = {
  id: string; client_id: string; redirect_uri: string; resource: string; scope: string;
  state: string | null; code_challenge: string; session_hash: string | null;
};
const pkce = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const verifierSchema = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/);
const clientSchema = z.object({
  client_name: z.string().trim().min(1).max(100).default('OAuth client'),
  redirect_uris: z.array(z.string().min(1).max(2048)).min(1).max(10),
  token_endpoint_auth_method: z.literal('none').default('none'),
  grant_types: z.array(z.enum(['authorization_code', 'refresh_token'])).default(['authorization_code', 'refresh_token']),
  response_types: z.array(z.literal('code')).default(['code']),
});

async function rateLimit(c: Context<AppEnv>, operation: string, limit: number) {
  const bucket = await digest(`oauth:${operation}:${c.req.header('CF-Connecting-IP') ?? 'local'}`);
  await c.env.DB.prepare('DELETE FROM login_attempts WHERE expires_at <= ?').bind(Date.now()).run();
  const row = await c.env.DB.prepare('INSERT INTO login_attempts (bucket, attempts, expires_at) VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1 RETURNING attempts')
    .bind(bucket, Date.now() + 15 * 60 * 1000).first<{ attempts: number }>();
  if (Number(row?.attempts) > limit) throw new OAuthError('temporarily_unavailable', 'Too many requests; try again in 15 minutes', 429);
}

function params(entries: Iterable<[string, string]>) {
  const result: Record<string, string> = Object.create(null);
  for (const [key, value] of entries) {
    if (Object.hasOwn(result, key)) throw new OAuthError('invalid_request', 'Duplicate OAuth parameter');
    result[key] = value;
  }
  return result;
}
async function form(c: Context<AppEnv>) {
  if (c.req.header('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') {
    throw new OAuthError('invalid_request', 'Content-Type must be application/x-www-form-urlencoded');
  }
  return params(new URLSearchParams(new TextDecoder().decode(await boundedBody(c.req.raw, 16 * 1024))));
}
function target(c: Context<AppEnv>, value: string | undefined) {
  let uri: string;
  try { uri = new URL(value ?? '').href; }
  catch { throw new OAuthError('invalid_target', 'A supported resource URI is required'); }
  if (![resourceUri(c, 'mcp'), resourceUri(c, 'api'), resourceUri(c, 'admin')].includes(uri)) {
    throw new OAuthError('invalid_target', 'Unsupported resource URI');
  }
  return uri;
}
function scopes(value: string | undefined) {
  const parts = [...new Set((value ?? 'read').split(' ').filter(Boolean))];
  if (!parts.length || parts.some((part) => !oauthScopes.includes(part))) {
    throw new OAuthError('invalid_scope', 'Use read, write, manage, or admin');
  }
  return oauthScopes.filter((scope) => parts.includes(scope)).join(' ');
}
// A discovery-driven client may request every MCP scope. Consent grants only
// the subset supported by the signed-in identity, never a combined identity.
function consentScope(requested: string, role: 'user' | 'admin') {
  return requested.split(' ').filter((scope) => role === 'admin' ? scope === 'admin' : scope !== 'admin').join(' ');
}
async function client(c: Context<AppEnv>, id: string | undefined) {
  const row = id ? await c.env.DB.prepare('SELECT id, name, redirect_uris, grant_types FROM oauth_clients WHERE id = ?').bind(id).first<Client>() : null;
  if (!row) throw new OAuthError('invalid_client', 'Unknown client');
  return row;
}
function validRedirect(uri: string) {
  try {
    const url = new URL(uri);
    return !/[\x00-\x20\x7f]/.test(uri) && !url.username && !url.password && !uri.includes('#') && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
  } catch { return false; }
}
async function authorization(c: Context<AppEnv>, id: string) {
  const row = await c.env.DB.prepare('SELECT * FROM oauth_requests WHERE id = ? AND consumed_by IS NULL AND expires_at > ?')
    .bind(id, new Date().toISOString()).first<Authorization>();
  if (!row) throw new OAuthError('invalid_request', 'Authorization request expired or already used');
  return row;
}
async function browserActor(c: Context<AppEnv>) {
  const current = await session(c);
  if (current?.role === 'admin' && c.env.ADMIN_TOKEN?.length >= 32 && current.admin_hash === await digest(c.env.ADMIN_TOKEN)) {
    return { role: 'admin' as const, principal: null, adminHash: current.admin_hash, name: '管理员' };
  }
  const principal = await sessionPrincipal(c);
  if (!principal) return null;
  const user = await c.env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(principal.user_id).first<{ name: string }>();
  return { role: 'user' as const, principal, adminHash: null, name: user!.name };
}
function callback(request: Authorization, values: Record<string, string>, issuer: string) {
  const url = new URL(request.redirect_uri);
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
  if (request.state !== null) url.searchParams.set('state', request.state);
  url.searchParams.set('iss', issuer);
  return url.href;
}

export function oauthMetadata(c: Context<AppEnv>) {
  const origin = new URL(c.req.url).origin;
  return c.json({
    issuer: origin, authorization_endpoint: origin + '/oauth/authorize', token_endpoint: origin + '/oauth/token',
    registration_endpoint: origin + '/oauth/register', revocation_endpoint: origin + '/oauth/revoke',
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'], revocation_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'], scopes_supported: oauthScopes,
    authorization_response_iss_parameter_supported: true,
  });
}
export function protectedMetadata(kind: 'mcp' | 'api' | 'admin') {
  return (c: Context<AppEnv>) => c.json({
    resource: resourceUri(c, kind), authorization_servers: [new URL(c.req.url).origin],
    scopes_supported: kind === 'admin' ? ['admin'] : kind === 'api' ? ['read', 'write', 'manage'] : oauthScopes,
    bearer_methods_supported: ['header'], resource_documentation: new URL('/llm', c.req.url).href,
  });
}

export const oauthApi = new Hono<AppEnv>();
oauthApi.onError((error, c) => {
  if (error instanceof OAuthError) return c.json({ error: error.code, error_description: error.message }, error.status);
  if (error instanceof HTTPException) return c.json({ error: 'invalid_request', error_description: error.message }, error.status);
  console.error('Unhandled OAuth error', error.name);
  return c.json({ error: 'server_error', error_description: 'Internal server error' }, 500);
});
oauthApi.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store'); c.header('Pragma', 'no-cache');
  if (['/token', '/register', '/revoke'].some((path) => c.req.path.endsWith(path))) {
    // These public-client endpoints do not use cookies or browser credentials.
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Content-Type');
    if (c.req.method === 'OPTIONS') return c.body(null, 204);
  }
  await next();
});

oauthApi.post('/register', async (c) => {
  await rateLimit(c, 'register', 20);
  let input: z.infer<typeof clientSchema>;
  try { input = await body(c, clientSchema); }
  catch (error) {
    if (error instanceof HTTPException && error.status === 400) throw new OAuthError('invalid_client_metadata', 'Invalid OAuth client metadata');
    throw error;
  }
  if (input.redirect_uris.some((uri) => !validRedirect(uri))) throw new OAuthError('invalid_redirect_uri', 'Redirect URIs must use HTTPS or HTTP loopback, without credentials or fragments');
  if (!input.grant_types.includes('authorization_code') || !input.response_types.length) throw new OAuthError('invalid_client_metadata', 'Authorization code flow is required');
  const id = oauthSecret('coao_client_');
  await c.env.DB.prepare('INSERT INTO oauth_clients (id, name, redirect_uris, grant_types, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, input.client_name, JSON.stringify([...new Set(input.redirect_uris)]), JSON.stringify([...new Set(input.grant_types)]), new Date().toISOString()).run();
  return c.json({ ...input, client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000) }, 201);
});

oauthApi.get('/authorize', async (c) => {
  const input = params(new URL(c.req.url).searchParams);
  const registered = await client(c, input.client_id);
  if (!input.redirect_uri || !(JSON.parse(registered.redirect_uris) as string[]).includes(input.redirect_uri)) throw new OAuthError('invalid_request', 'Redirect URI does not exactly match the registered URI');
  if (input.response_type !== 'code') throw new OAuthError('unsupported_response_type', 'Only authorization code flow is supported');
  if (input.code_challenge_method !== 'S256' || !pkce.safeParse(input.code_challenge).success) throw new OAuthError('invalid_request', 'S256 PKCE is required');
  if (input.state?.length > 2048) throw new OAuthError('invalid_request', 'State is too long');
  const resource = target(c, input.resource), scope = scopes(input.scope);
  if (resource !== resourceUri(c, 'mcp') && (resource === resourceUri(c, 'admin') ? scope !== 'admin' : scope.split(' ').includes('admin'))) throw new OAuthError('invalid_scope', 'Scope does not match the resource');
  const id = oauthSecret('');
  await c.env.DB.prepare('DELETE FROM oauth_requests WHERE expires_at <= ?').bind(new Date().toISOString()).run();
  await c.env.DB.prepare('INSERT INTO oauth_requests (id, client_id, redirect_uri, resource, scope, state, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, registered.id, input.redirect_uri, resource, scope, input.state ?? null, input.code_challenge, expiresIn(600)).run();
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  return c.html(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>co-ai · 应用授权</title><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/oauth.css"><script src="/oauth.js" type="module"></script></head><body><main id="oauth-app" class="oauth-page" data-request="${id}"><section class="card"><h1>co-ai 应用授权</h1><p>正在读取授权请求…</p></section></main></body></html>`);
});

oauthApi.get('/requests/:requestId', async (c) => {
  const request = await authorization(c, c.req.param('requestId'));
  const registered = await client(c, request.client_id), actor = await browserActor(c);
  if (actor) {
    const hash = await digest(getCookie(c, '__Host-coai_session')!);
    await c.env.DB.prepare('UPDATE oauth_requests SET session_hash = ? WHERE id = ? AND (session_hash IS NULL OR NOT EXISTS (SELECT 1 FROM web_sessions WHERE token_hash = oauth_requests.session_hash AND expires_at > ?))').bind(hash, request.id, new Date().toISOString()).run();
    const binding = await c.env.DB.prepare('SELECT session_hash FROM oauth_requests WHERE id = ?').bind(request.id).first<{ session_hash: string }>();
    if (binding?.session_hash !== hash) throw new OAuthError('invalid_request', 'Authorization request belongs to another browser session', 403);
  }
  const projects = actor?.principal ? (await c.env.DB.prepare('SELECT id, name FROM projects WHERE owner_id = ? AND archived_at IS NULL ORDER BY name, id').bind(actor.principal.user_id).all()).results : [];
  return c.json({ data: { client_name: registered.name, redirect_uri: request.redirect_uri, resource: request.resource, scope: actor ? consentScope(request.scope, actor.role) : request.scope, actor: actor ? { role: actor.role, name: actor.name } : null, projects } });
});

oauthApi.post('/consent', async (c) => {
  if (c.req.header('Origin') !== new URL(c.req.url).origin) throw new OAuthError('invalid_request', 'Same-origin request required', 403);
  const input = await body(c, z.object({ request_id: z.string().regex(/^[a-f0-9]{64}$/), decision: z.enum(['approve', 'deny']), project_id: z.uuid().nullable().optional() }).strict());
  const request = await authorization(c, input.request_id), actor = await browserActor(c);
  if (!actor || request.session_hash !== await digest(getCookie(c, '__Host-coai_session') ?? '')) throw new OAuthError('access_denied', 'Sign in and review the authorization request first', 403);
  const issuer = new URL(c.req.url).origin, claim = oauthSecret('');
  if (input.decision === 'deny') {
    const result = await c.env.DB.prepare('UPDATE oauth_requests SET consumed_by = ? WHERE id = ? AND consumed_by IS NULL AND expires_at > ?').bind(claim, request.id, new Date().toISOString()).run();
    if (!result.meta.changes) throw new OAuthError('invalid_request', 'Authorization request already used');
    return c.json({ data: { redirect: callback(request, { error: 'access_denied' }, issuer) } });
  }
  const scope = consentScope(request.scope, actor.role);
  if (!scope) throw new OAuthError('access_denied', 'This account cannot authorize the requested scopes', 403);
  const admin = scope === 'admin';
  if (admin !== (actor.role === 'admin')) throw new OAuthError('access_denied', admin ? 'Administrator sign-in required' : 'User sign-in required', 403);
  const manage = scope.split(' ').includes('manage');
  if (!admin && !manage && !input.project_id) throw new OAuthError('invalid_request', 'Select a project');
  if ((admin || manage) && input.project_id) throw new OAuthError('invalid_request', 'This scope authorizes account management, not a single project');
  if (input.project_id && !await c.env.DB.prepare('SELECT id FROM projects WHERE id = ? AND owner_id = ? AND archived_at IS NULL').bind(input.project_id, actor.principal!.user_id).first()) throw new OAuthError('access_denied', 'Project not available', 403);
  const grantId = crypto.randomUUID(), code = oauthSecret('coao_code_');
  const key = admin ? null : await newKey(c.env, actor.principal!.user_id, input.project_id ?? null, 'OAuth: ' + (await client(c, request.client_id)).name, scope.split(' ').some((scope) => ['write', 'manage'].includes(scope)) ? 'write' : 'read');
  const password = admin ? null : await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(actor.principal!.user_id).first<{ password_hash: string | null }>();
  const timestamp = new Date().toISOString();
  // Each insert is conditional on this transaction's unique claim, preventing
  // concurrent approval from issuing a second code or orphan actor key.
  const statements = [c.env.DB.prepare('UPDATE oauth_requests SET consumed_by = ? WHERE id = ? AND consumed_by IS NULL AND expires_at > ?').bind(claim, request.id, timestamp)];
  if (key) statements.push(c.env.DB.prepare('INSERT INTO api_keys (id, user_id, project_id, name, key_hash, permission, created_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM oauth_requests WHERE id = ? AND consumed_by = ?)')
    .bind(key.data.id, actor.principal!.user_id, input.project_id ?? null, key.data.name, await digest(key.data.api_key), key.data.permission, timestamp, request.id, claim));
  statements.push(
    c.env.DB.prepare('INSERT INTO oauth_grants (id, client_id, resource, scope, key_id, admin_hash, password_hash, created_at, expires_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM oauth_requests WHERE id = ? AND consumed_by = ?)')
      .bind(grantId, request.client_id, request.resource, scope, key?.data.id ?? null, actor.adminHash, password?.password_hash ?? null, timestamp, expiresIn(grantLifetime), request.id, claim),
    c.env.DB.prepare('INSERT INTO oauth_codes (token_hash, grant_id, redirect_uri, code_challenge, expires_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM oauth_requests WHERE id = ? AND consumed_by = ?)')
      .bind(await digest(code), grantId, request.redirect_uri, request.code_challenge, expiresIn(300), request.id, claim),
  );
  const result = await c.env.DB.batch(statements);
  if (!result[0].meta.changes) throw new OAuthError('invalid_request', 'Authorization request already used');
  return c.json({ data: { redirect: callback(request, { code }, issuer) } });
});

oauthApi.post('/token', async (c) => {
  await rateLimit(c, 'token', 100);
  const input = await form(c), registered = await client(c, input.client_id), resource = target(c, input.resource);
  if (c.req.header('Authorization') || input.client_secret) throw new OAuthError('invalid_client', 'Only public clients with authentication method none are supported');
  const table = input.grant_type === 'authorization_code' ? 'oauth_codes' : input.grant_type === 'refresh_token' ? 'oauth_refresh_tokens' : null;
  if (!table) throw new OAuthError('unsupported_grant_type', 'Use authorization_code or refresh_token');
  if (!(JSON.parse(registered.grant_types) as string[]).includes(input.grant_type)) throw new OAuthError('unauthorized_client', 'Client is not registered for this grant type');
  const secret = table === 'oauth_codes' ? input.code : input.refresh_token;
  if (!secret) throw new OAuthError('invalid_grant', 'Missing code or refresh token');
  const hash = await digest(secret);
  const row = await c.env.DB.prepare(`SELECT t.*, g.client_id, g.resource, g.scope, g.expires_at AS grant_expires_at FROM ${table} t JOIN oauth_grants g ON g.id = t.grant_id WHERE t.token_hash = ?`)
    .bind(hash).first<{ grant_id: string; client_id: string; resource: string; scope: string; expires_at: string; grant_expires_at: string; consumed_by: string | null; redirect_uri?: string; code_challenge?: string }>();
  if (!row || row.client_id !== registered.id || row.resource !== resource || row.expires_at <= new Date().toISOString()) throw new OAuthError('invalid_grant', 'Invalid or expired grant');
  if (table === 'oauth_codes') {
    if (input.redirect_uri !== row.redirect_uri || !verifierSchema.safeParse(input.code_verifier).success) throw new OAuthError('invalid_grant', 'Invalid redirect URI or PKCE verifier');
    const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.code_verifier))))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (challenge !== row.code_challenge) throw new OAuthError('invalid_grant', 'Invalid PKCE verifier');
  }
  if (row.consumed_by) {
    await c.env.DB.prepare('UPDATE oauth_grants SET revoked_at = ? WHERE id = ?').bind(new Date().toISOString(), row.grant_id).run();
    throw new OAuthError('invalid_grant', 'Grant already used');
  }
  if (!await grantIdentity(c.env, row.grant_id)) throw new OAuthError('invalid_grant', 'Authorization is no longer active');
  if (input.scope && scopes(input.scope) !== row.scope) throw new OAuthError('invalid_scope', 'Refresh cannot change granted scopes; authorize again');
  const access = oauthSecret('coao_at_'), refresh = oauthSecret('coao_rt_'), claim = oauthSecret('');
  const lifetime = Math.min(accessLifetime, Math.floor((Date.parse(row.grant_expires_at) - Date.now()) / 1000));
  if (lifetime < 1) throw new OAuthError('invalid_grant', 'Authorization expired');
  const timestamp = new Date().toISOString();
  const result = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE ${table} SET consumed_by = ? WHERE token_hash = ? AND consumed_by IS NULL AND expires_at > ?`).bind(claim, hash, timestamp),
    c.env.DB.prepare(`INSERT INTO oauth_access_tokens (token_hash, grant_id, expires_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM ${table} WHERE token_hash = ? AND consumed_by = ?)`)
      .bind(await digest(access), row.grant_id, expiresIn(lifetime), hash, claim),
    c.env.DB.prepare(`INSERT INTO oauth_refresh_tokens (token_hash, grant_id, expires_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM ${table} WHERE token_hash = ? AND consumed_by = ?)`)
      .bind(await digest(refresh), row.grant_id, row.grant_expires_at, hash, claim),
  ]);
  if (!result[0].meta.changes) {
    await c.env.DB.prepare('UPDATE oauth_grants SET revoked_at = ? WHERE id = ?').bind(timestamp, row.grant_id).run();
    throw new OAuthError('invalid_grant', 'Grant already used');
  }
  return c.json({ access_token: access, token_type: 'Bearer', expires_in: lifetime, ...((JSON.parse(registered.grant_types) as string[]).includes('refresh_token') ? { refresh_token: refresh } : {}), scope: row.scope });
});

oauthApi.post('/revoke', async (c) => {
  await rateLimit(c, 'revoke', 100);
  const input = await form(c), registered = await client(c, input.client_id);
  if (c.req.header('Authorization') || input.client_secret) throw new OAuthError('invalid_client', 'Only public clients are supported');
  if (!input.token) throw new OAuthError('invalid_request', 'Token is required');
  const hash = await digest(input.token);
  await c.env.DB.prepare(`UPDATE oauth_grants SET revoked_at = ? WHERE client_id = ? AND id IN (
    SELECT grant_id FROM oauth_access_tokens WHERE token_hash = ? UNION SELECT grant_id FROM oauth_refresh_tokens WHERE token_hash = ?)`)
    .bind(new Date().toISOString(), registered.id, hash, hash).run();
  return c.body(null, 200);
});
