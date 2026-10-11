import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv, Env } from './types';

export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function bearer(c: Context<AppEnv>): string {
  const match = /^Bearer ([^\s]+)$/i.exec(c.req.header('Authorization') ?? '');
  if (!match) throw new HTTPException(401, { message: 'Bearer API key required' });
  return match[1];
}

export async function newKey(env: Env, userId: string, projectId: string | null, name: string, permission: 'read' | 'write') {
  const id = crypto.randomUUID();
  const secret = 'coai_' + Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
  const createdAt = new Date().toISOString();
  const statement = env.DB.prepare('INSERT INTO api_keys (id, user_id, project_id, name, key_hash, permission, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, userId, projectId, name, await digest(secret), permission, createdAt);
  return { statement, data: { id, name, project_id: projectId, permission, created_at: createdAt, api_key: secret } };
}

export function ownerOnly(c: Context<AppEnv>) {
  if (c.get('principal').project_id !== null) throw new HTTPException(403, { message: 'User API key required' });
}

export function writable(c: Context<AppEnv>) {
  if (c.get('principal').permission !== 'write') throw new HTTPException(403, { message: 'Read-only API key' });
}

export async function resetUserKey(env: Env, userId: string) {
  const key = await newKey(env, userId, null, 'Reset user key', 'write');
  await env.DB.batch([
    env.DB.prepare("UPDATE api_keys SET revoked_at = ? WHERE user_id = ? AND project_id IS NULL AND kind = 'api' AND revoked_at IS NULL").bind(new Date().toISOString(), userId),
    env.DB.prepare("DELETE FROM web_sessions WHERE key_id IN (SELECT id FROM api_keys WHERE user_id = ? AND project_id IS NULL AND kind = 'api')").bind(userId), key.statement,
  ]);
  return key.data;
}
