import { z } from 'zod';
import { HTTPException } from 'hono/http-exception';
import type { Env } from './types';
import { digest } from './security';

export const usernameField = z.string().trim().min(3).max(64).regex(/^[a-zA-Z0-9_.-]+$/, 'Username must contain only letters, numbers, dots, underscores or hyphens').transform((v) => v.toLowerCase());
export const passwordField = z.string().min(12).max(256);
const hex = (bytes: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
async function derive(password: string, salt: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  // Workerd supports at most 100,000 PBKDF2 iterations per derivation.
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 100000 }, key, 256));
}
export async function hashPassword(password: string) {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  return `pbkdf2-sha256$100000$${salt}$${await derive(password, salt)}`;
}
export async function verifyPassword(password: string, stored: string | null) {
  const parts = (stored ?? '').split('$');
  const valid = parts.length === 4 && parts[0] === 'pbkdf2-sha256' && parts[1] === '100000' && /^[a-f0-9]{32}$/.test(parts[2]) && /^[a-f0-9]{64}$/.test(parts[3]);
  const actual = await derive(password, valid ? parts[2] : '00000000000000000000000000000000');
  const expected = valid ? parts[3] : '0'.repeat(64);
  let difference = 0;
  for (let i = 0; i < actual.length; i++) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return valid && difference === 0;
}
export async function passwordActor(env: Env, userId: string) {
  const id = crypto.randomUUID();
  const secret = hex(crypto.getRandomValues(new Uint8Array(32)));
  return env.DB.prepare('INSERT OR IGNORE INTO api_keys (id, user_id, project_id, name, key_hash, permission, created_at, kind) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)')
    .bind(id, userId, 'Password session identity', await digest(secret), 'write', new Date().toISOString(), 'password');
}
export async function checkUsername(env: Env, username: string, userId: string) {
  if (await env.DB.prepare('SELECT id FROM users WHERE username = ? AND id != ?').bind(username, userId).first()) throw new HTTPException(409, { message: 'Username already exists' });
}
