import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv, Principal } from './types';
import { digest, resetUserKey } from './security';
import { body } from './http';
import { usernameField, passwordField, verifyPassword, hashPassword, passwordActor, checkUsername } from './passwords';
import { oauthIdentity, requireOAuthScope } from './oauth-security';

const cookieName = (_c: Context<AppEnv>) => '__Host-coai_session';
const cookieOptions = (_c: Context<AppEnv>) => ({ path: '/', httpOnly: true, secure: true, sameSite: 'Strict' as const });

export const csrfGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && (getCookie(c, cookieName(c)) || c.req.path.startsWith('/api/web/'))) {
    if (c.req.header('Origin') !== new URL(c.req.url).origin) throw new HTTPException(403, { message: 'Same-origin request required' });
  }
  await next();
};

export type Session = { role: 'admin' | 'user'; key_id: string | null; admin_hash: string | null; password_hash: string | null };
export async function session(c: Context<AppEnv>): Promise<Session | null> {
  const token = getCookie(c, cookieName(c));
  if (!token) return null;
  return c.env.DB.prepare('SELECT role, key_id, admin_hash, password_hash FROM web_sessions WHERE token_hash = ? AND expires_at > ?')
    .bind(await digest(token), new Date().toISOString()).first<Session>();
}

export async function sessionPrincipal(c: Context<AppEnv>): Promise<Principal | null> {
  const row = await session(c);
  if (row?.role !== 'user') return null;
  return c.env.DB.prepare("SELECT k.id, k.user_id, k.project_id, k.permission FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.id = ? AND k.project_id IS NULL AND k.revoked_at IS NULL AND u.disabled_at IS NULL AND (k.kind = 'api' OR u.password_hash = ?)")
    .bind(row.key_id, row.password_hash).first<Principal>();
}

export async function requireAdmin(c: Context<AppEnv>) {
  const oauth = await oauthIdentity(c, 'admin');
  if (oauth) {
    requireOAuthScope(c, oauth, 'admin');
    if (oauth.adminHash) return;
    throw new HTTPException(403, { message: 'Administrator OAuth authorization required' });
  }
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
  const input = await body(c, z.union([
    z.object({ role: z.enum(['admin', 'user']), credential: z.string().min(1).max(256) }).strict(),
    z.object({ role: z.literal('user'), username: usernameField, password: z.string().min(1).max(256) }).strict(),
  ]));
  let keyId: string | null = null, adminHash: string | null = null, passwordHash: string | null = null;
  if (input.role === 'admin') {
    if (!c.env.ADMIN_TOKEN || c.env.ADMIN_TOKEN.length < 32) throw new HTTPException(503, { message: 'Administrator provisioning is not configured' });
    adminHash = await digest(c.env.ADMIN_TOKEN);
    if (await digest(input.credential) !== adminHash) throw new HTTPException(401, { message: 'Invalid credentials' });
  } else if ('password' in input) {
    const timestamp = Date.now();
    const buckets = [await digest('username:' + input.username), await digest('ip:' + (c.req.header('CF-Connecting-IP') ?? 'local'))];
    await c.env.DB.prepare('DELETE FROM login_attempts WHERE expires_at <= ?').bind(timestamp).run();
    const attempts = await c.env.DB.batch<{ attempts: number }>(buckets.map((bucket) => c.env.DB.prepare('INSERT INTO login_attempts (bucket, attempts, expires_at) VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1 RETURNING attempts')
      .bind(bucket, timestamp + 15 * 60 * 1000)));
    if (attempts.some((result, i) => Number(result.results[0].attempts) > (i === 0 ? 10 : 50))) throw new HTTPException(429, { message: 'Too many login attempts; try again in 15 minutes' });
    const user = await c.env.DB.prepare('SELECT id, password_hash, disabled_at FROM users WHERE username = ?')
      .bind(input.username).first<{ id: string; password_hash: string | null; disabled_at: string | null }>();
    const valid = await verifyPassword(input.password, user?.password_hash ?? null);
    if (!valid || !user || user.disabled_at) throw new HTTPException(401, { message: 'Invalid credentials' });
    const key = await c.env.DB.prepare("SELECT id FROM api_keys WHERE user_id = ? AND kind = 'password' AND revoked_at IS NULL").bind(user.id).first<{ id: string }>();
    if (!key) throw new HTTPException(401, { message: 'Invalid credentials' });
    keyId = key.id;
    passwordHash = user.password_hash;
  } else {
    const key = await c.env.DB.prepare("SELECT k.id FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = ? AND k.kind = 'api' AND k.project_id IS NULL AND k.revoked_at IS NULL AND u.disabled_at IS NULL")
      .bind(await digest(input.credential)).first<{ id: string }>();
    if (!key) throw new HTTPException(401, { message: 'Invalid credentials; use an active user key' });
    keyId = key.id;
  }
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
  const old = getCookie(c, cookieName(c));
  const timestamp = new Date().toISOString();
  const statements = [c.env.DB.prepare('DELETE FROM web_sessions WHERE expires_at <= ?').bind(timestamp)];
  if (old) statements.push(c.env.DB.prepare('DELETE FROM web_sessions WHERE token_hash = ?').bind(await digest(old)));
  statements.push(c.env.DB.prepare('INSERT INTO web_sessions (token_hash, role, key_id, admin_hash, password_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(await digest(token), input.role, keyId, adminHash, passwordHash, new Date(Date.now() + 24 * 3600 * 1000).toISOString()));
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
  const user = await c.env.DB.prepare('SELECT id, name, email, username, password_hash IS NOT NULL AS has_password FROM users WHERE id = ?').bind(principal.user_id).first();
  return c.json({ data: { role: 'user', user } });
});
webAuth.post('/logout', async (c) => {
  const token = getCookie(c, cookieName(c));
  if (token) await c.env.DB.prepare('DELETE FROM web_sessions WHERE token_hash = ?').bind(await digest(token)).run();
  deleteCookie(c, cookieName(c), cookieOptions(c));
  return c.body(null, 204);
});

webAuth.put('/credentials', async (c) => {
  const principal = await sessionPrincipal(c);
  if (!principal) throw new HTTPException(401, { message: 'Sign in required' });
  const input = await body(c, z.object({ username: usernameField, password: passwordField, current_password: z.string().max(256).optional() }).strict());
  const user = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(principal.user_id).first<{ password_hash: string | null }>();
  if (!user) throw new HTTPException(401, { message: 'Sign in required' });
  if (user.password_hash && !await verifyPassword(input.current_password ?? '', user.password_hash)) throw new HTTPException(403, { message: 'Current password is incorrect' });
  await checkUsername(c.env, input.username, principal.user_id);
  const hash = await hashPassword(input.password);
  try {
    const result = await c.env.DB.batch([
      c.env.DB.prepare('UPDATE users SET username = ?, password_hash = ? WHERE id = ? AND password_hash IS ? RETURNING id')
        .bind(input.username, hash, principal.user_id, user.password_hash),
      await passwordActor(c.env, principal.user_id),
      c.env.DB.prepare("DELETE FROM web_sessions WHERE key_id IN (SELECT id FROM api_keys WHERE user_id = ? AND kind = 'password') AND EXISTS (SELECT 1 FROM users WHERE id = ? AND password_hash = ?)").bind(principal.user_id, principal.user_id, hash),
    ]);
    if (!result[0].results.length) throw new HTTPException(409, { message: 'Credentials changed; refresh and retry' });
  } catch (error) {
    await checkUsername(c.env, input.username, principal.user_id);
    throw error;
  }
  return c.body(null, 204);
});
webAuth.post('/reset-key', async (c) => {
  const principal = await sessionPrincipal(c);
  if (!principal) throw new HTTPException(401, { message: 'Sign in required' });
  return c.json({ data: await resetUserKey(c.env, principal.user_id) }, 201);
});
