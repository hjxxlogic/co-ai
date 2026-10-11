import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv, Env, Principal } from './types';
import { bearer, digest } from './security';

export const oauthContext = Symbol('oauthContext');
export interface OAuthIdentity {
  grantId: string;
  resource: string;
  scope: string;
  principal: Principal | null;
  adminHash: string | null;
}
export type OAuthEnv = Env & { [oauthContext]?: OAuthIdentity };
export const oauthScopes = ['read', 'write', 'manage', 'admin'];
export const accessLifetime = 3600;
export const grantLifetime = 30 * 24 * 3600;
export const expiresIn = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
export const oauthSecret = (prefix: string) => prefix + Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');

export function resourceUri(c: Context<AppEnv>, kind: 'mcp' | 'api' | 'admin') {
  return new URL(kind === 'mcp' ? '/mcp' : kind === 'admin' ? '/api/admin' : '/api/v1', c.req.url).href;
}
export function resourceMetadata(c: Context<AppEnv>, kind: 'mcp' | 'api' | 'admin') {
  return new URL('/.well-known/oauth-protected-resource' + (kind === 'mcp' ? '/mcp' : kind === 'admin' ? '/api/admin' : '/api/v1'), c.req.url).href;
}
export function challenge(c: Context<AppEnv>, status: 401 | 403, scope?: string) {
  const kind = c.req.path === '/mcp' || c.req.path.startsWith('/mcp/') ? 'mcp' : c.req.path.startsWith('/api/admin') ? 'admin' : 'api';
  return `Bearer resource_metadata="${resourceMetadata(c, kind)}", scope="${scope ?? (kind === 'admin' ? 'admin' : 'read')}", error="${status === 401 ? 'invalid_token' : 'insufficient_scope'}"`;
}

export async function grantIdentity(env: Env, grantId: string): Promise<OAuthIdentity | null> {
  const row = await env.DB.prepare(`SELECT g.id, g.resource, g.scope, g.admin_hash, g.key_id,
    k.user_id, k.project_id, k.permission, k.revoked_at AS key_revoked_at,
    u.disabled_at, u.password_hash AS current_password_hash, g.password_hash,
    p.archived_at FROM oauth_grants g
    LEFT JOIN api_keys k ON k.id = g.key_id LEFT JOIN users u ON u.id = k.user_id
    LEFT JOIN projects p ON p.id = k.project_id
    WHERE g.id = ? AND g.revoked_at IS NULL AND g.expires_at > ?`)
    .bind(grantId, new Date().toISOString()).first<{
      id: string; resource: string; scope: string; admin_hash: string | null;
      key_id: string | null; user_id: string | null; project_id: string | null;
      permission: 'read' | 'write'; key_revoked_at: string | null; disabled_at: string | null;
      current_password_hash: string | null; password_hash: string | null; archived_at: string | null;
    }>();
  if (!row) return null;
  if (row.admin_hash) {
    if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32 || await digest(env.ADMIN_TOKEN) !== row.admin_hash) return null;
    return { grantId: row.id, resource: row.resource, scope: row.scope, principal: null, adminHash: row.admin_hash };
  }
  if (!row.key_id || !row.user_id || row.key_revoked_at || row.disabled_at || row.archived_at || row.current_password_hash !== row.password_hash) return null;
  return {
    grantId: row.id, resource: row.resource, scope: row.scope, adminHash: null,
    principal: { id: row.key_id, user_id: row.user_id, project_id: row.project_id, permission: row.permission },
  };
}

export async function oauthIdentity(c: Context<AppEnv>, kind: 'mcp' | 'api' | 'admin'): Promise<OAuthIdentity | null> {
  // Only the in-process MCP dispatcher can supply this binding. HTTP clients
  // cannot forge it, and an MCP token is never accepted by the public REST URL.
  const internal = (c.env as OAuthEnv)[oauthContext];
  if (internal) return internal;
  const header = c.req.header('Authorization');
  if (!header || !/^Bearer coao_/i.test(header)) return null;
  const token = bearer(c);
  const row = await c.env.DB.prepare('SELECT grant_id FROM oauth_access_tokens WHERE token_hash = ? AND expires_at > ?')
    .bind(await digest(token), new Date().toISOString()).first<{ grant_id: string }>();
  const identity = row ? await grantIdentity(c.env, row.grant_id) : null;
  if (!identity || identity.resource !== resourceUri(c, kind)) throw new HTTPException(401, { message: 'Invalid or expired OAuth access token' });
  return identity;
}

export function requireOAuthScope(c: Context<AppEnv>, identity: OAuthIdentity, scope: 'read' | 'write' | 'manage' | 'admin') {
  const scopes = identity.scope.split(' ');
  const allowed = scope === 'read' ? scopes.some((value) => ['read', 'write', 'manage'].includes(value))
    : scope === 'write' ? scopes.some((value) => ['write', 'manage'].includes(value)) : scopes.includes(scope);
  if (!allowed) {
    c.header('WWW-Authenticate', challenge(c, 403, scope));
    throw new HTTPException(403, { message: `OAuth scope ${scope} required` });
  }
}
