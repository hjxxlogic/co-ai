import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv } from './types';
import { body, pagination } from './http';
import { newKey } from './security';
import { requireAdmin } from './web-auth';

export const adminApi = new Hono<AppEnv>();
const userFields = z.object({ email: z.email().max(254), name: z.string().trim().min(1).max(200) }).strict();
adminApi.use('*', async (c, next) => { await requireAdmin(c); await next(); });
adminApi.get('/users', async (c) => {
  const { limit, after } = pagination(c);
  const { results } = await c.env.DB.prepare('SELECT u.id, u.email, u.name, u.created_at, u.disabled_at, (SELECT COUNT(*) FROM projects p WHERE p.owner_id = u.id AND p.archived_at IS NULL) AS project_count FROM users u WHERE u.id > ? ORDER BY u.id LIMIT ?')
    .bind(after, limit + 1).all<{ id: string }>();
  const data = results.slice(0, limit);
  return c.json({ data, next_cursor: results.length > limit ? data.at(-1)!.id : null });
});
adminApi.post('/users', async (c) => {
  const input = await body(c, userFields);
  const user = { id: crypto.randomUUID(), email: input.email.toLowerCase(), name: input.name, created_at: new Date().toISOString() };
  const key = await newKey(c.env, user.id, null, 'Initial user key', 'write');
  try {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)').bind(user.id, user.email, user.name, user.created_at), key.statement,
    ]);
  } catch (error) {
    if (await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(user.email).first()) throw new HTTPException(409, { message: 'Email already exists' });
    throw error;
  }
  return c.json({ data: { user, key: key.data } }, 201);
});
adminApi.patch('/users/:userId', async (c) => {
  const input = await body(c, userFields.partial().extend({ disabled: z.boolean().optional() }).refine((v) => Object.keys(v).length > 0, 'At least one field is required'));
  const id = c.req.param('userId');
  const timestamp = new Date().toISOString();
  let row;
  try {
    const statements = [c.env.DB.prepare('UPDATE users SET name = COALESCE(?, name), email = COALESCE(?, email), disabled_at = CASE WHEN ? IS NULL THEN disabled_at WHEN ? = 1 THEN ? ELSE NULL END WHERE id = ? RETURNING id, email, name, created_at, disabled_at')
      .bind(input.name ?? null, input.email?.toLowerCase() ?? null, input.disabled === undefined ? null : Number(input.disabled), Number(input.disabled ?? false), timestamp, id)];
    if (input.disabled) statements.push(c.env.DB.prepare('DELETE FROM web_sessions WHERE key_id IN (SELECT id FROM api_keys WHERE user_id = ?)').bind(id));
    row = (await c.env.DB.batch(statements))[0].results[0];
  } catch (error) {
    if (input.email && await c.env.DB.prepare('SELECT id FROM users WHERE email = ? AND id != ?').bind(input.email.toLowerCase(), id).first()) throw new HTTPException(409, { message: 'Email already exists' });
    throw error;
  }
  if (!row) throw new HTTPException(404, { message: 'User not found' });
  return c.json({ data: row });
});
adminApi.post('/users/:userId/reset-key', async (c) => {
  const id = c.req.param('userId');
  if (!await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(id).first()) throw new HTTPException(404, { message: 'User not found' });
  const key = await newKey(c.env, id, null, 'Reset user key', 'write');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE api_keys SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').bind(new Date().toISOString(), id),
    c.env.DB.prepare('DELETE FROM web_sessions WHERE key_id IN (SELECT id FROM api_keys WHERE user_id = ?)').bind(id), key.statement,
  ]);
  return c.json({ data: key.data }, 201);
});
