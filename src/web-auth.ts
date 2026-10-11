import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv, Principal } from './types';
import { digest } from './security';
import { body } from './http';

const cookieName = (_c: Context<AppEnv>) => '__Host-coai_session';
const cookieOptions = (_c: Context<AppEnv>) => ({ path: '/', httpOnly: true, secure: true, sameSite: 'Strict' as const });

export const csrfGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && (getCookie(c, cookieName(c)) || c.req.path.startsWith('/api/web/'))) {
    if (c.req.header('Origin') !== new URL(c.req.url).origin) throw new HTTPException(403, { message: 'Same-origin request required' });
  }
  await next();
};

type Session = { role: 'admin' | 'user'; key_id: string | null; admin_hash: string | null };
async function session(c: Context<AppEnv>): Promise<Session | null> {
  const token = getCookie(c, cookieName(c));
  if (!token) return null;
  return c.env.DB.prepare('SELECT role, key_id, admin_hash FROM web_sessions WHERE token_hash = ? AND expires_at > ?')
    .bind(await digest(token), new Date().toISOString()).first<Session>();
}

export async function sessionPrincipal(c: Context<AppEnv>): Promise<Principal | null> {
  const row = await session(c);
  if (row?.role !== 'user') return null;
  return c.env.DB.prepare('SELECT k.id, k.user_id, k.project_id, k.permission FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.id = ? AND k.project_id IS NULL AND k.revoked_at IS NULL AND u.disabled_at IS NULL')
    .bind(row.key_id).first<Principal>();
}

export async function requireAdmin(c: Context<AppEnv>) {
  if (!c.env.ADMIN_TOKEN || c.env.ADMIN_TOKEN.length < 32) throw new HTTPException(503, { message: 'Administrator provisioning is not configured' });
  const expected = await digest(c.env.ADMIN_TOKEN);
  const authorization = c.req.header('Authorization');
  if (authorization) {
    const match = /^Bearer ([^\s]+)$/i.exec(authorization);
    if (match && await digest(match[1]) === expected) return;
  } else {
    const row = await session(c);
    if (row?.role === 'admin' && row.admin_hash === expected) return;
  }
  throw new HTTPException(401, { message: 'Administrator authentication required' });
}

export const webAuth = new Hono<AppEnv>();
webAuth.post('/login', async (c) => {
  const input = await body(c, z.object({ role: z.enum(['admin', 'user']), credential: z.string().min(1).max(256) }).strict());
  let keyId: string | null = null, adminHash: string | null = null;
  if (input.role === 'admin') {
    if (!c.env.ADMIN_TOKEN || c.env.ADMIN_TOKEN.length < 32) throw new HTTPException(503, { message: 'Administrator provisioning is not configured' });
    adminHash = await digest(c.env.ADMIN_TOKEN);
    if (await digest(input.credential) !== adminHash) throw new HTTPException(401, { message: 'Invalid credentials' });
  } else {
    const key = await c.env.DB.prepare('SELECT k.id FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = ? AND k.project_id IS NULL AND k.revoked_at IS NULL AND u.disabled_at IS NULL')
      .bind(await digest(input.credential)).first<{ id: string }>();
    if (!key) throw new HTTPException(401, { message: 'Invalid credentials; use an active user key' });
    keyId = key.id;
  }
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
  const old = getCookie(c, cookieName(c));
  const timestamp = new Date().toISOString();
  const statements = [c.env.DB.prepare('DELETE FROM web_sessions WHERE expires_at <= ?').bind(timestamp)];
  if (old) statements.push(c.env.DB.prepare('DELETE FROM web_sessions WHERE token_hash = ?').bind(await digest(old)));
  statements.push(c.env.DB.prepare('INSERT INTO web_sessions (token_hash, role, key_id, admin_hash, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(await digest(token), input.role, keyId, adminHash, new Date(Date.now() + 24 * 3600 * 1000).toISOString()));
  await c.env.DB.batch(statements);
  setCookie(c, cookieName(c), token, { ...cookieOptions(c), maxAge: 24 * 3600 });
  return c.json({ data: { role: input.role } });
});
webAuth.get('/session', async (c) => {
  const row = await session(c);
  if (row?.role === 'admin') {
    await requireAdmin(c);
    return c.json({ data: { role: 'admin', name: '管理员' } });
  }
  const principal = await sessionPrincipal(c);
  if (!principal) throw new HTTPException(401, { message: 'Sign in required' });
  const user = await c.env.DB.prepare('SELECT id, name, email FROM users WHERE id = ?').bind(principal.user_id).first();
  return c.json({ data: { role: 'user', user } });
});
webAuth.post('/logout', async (c) => {
  const token = getCookie(c, cookieName(c));
  if (token) await c.env.DB.prepare('DELETE FROM web_sessions WHERE token_hash = ?').bind(await digest(token)).run();
  deleteCookie(c, cookieName(c), cookieOptions(c));
  return c.body(null, 204);
});
