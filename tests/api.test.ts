import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFile } from 'node:fs/promises';
import app from '../src/index';
import type { Env } from '../src/types';
import { digest } from '../src/security';
import { deliverMessageEvents, signedHeaders } from '../src/mcp-events';
import { webhookPost } from '../src/event-webhook';
vi.mock('../src/event-webhook', async (original) => ({
  ...await original<typeof import('../src/event-webhook')>(),
  webhookPost: vi.fn(async (_url: string, body: string) => ({ status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) })),
}));
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

let mf: Miniflare;
let env: Env;
const migrationIds = Object.fromEntries(['users', 'api_keys', 'projects', 'roles', 'items', 'attachments'].map((table) => [table, crypto.randomUUID()]));
let migrationRows: Record<string, Record<string, unknown>> = {};
const admin = 'test-admin-secret-with-at-least-32-characters';

async function request(path: string, key?: string, method = 'GET', input?: unknown) {
  const headers: Record<string, string> = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  if (input !== undefined) headers['Content-Type'] = 'application/json';
  return app.request(`https://co-ai.test${path}`, { method, headers, body: input === undefined ? undefined : JSON.stringify(input) }, env);
}
async function provision(email: string) {
  const res = await request('/api/admin/users', admin, 'POST', { email, name: email });
  expect(res.status).toBe(201);
  return (await res.json() as any).data.key.api_key as string;
}
async function createProject(key: string, name = 'Project') {
  const res = await request('/api/v1/projects', key, 'POST', { name, instructions: 'Record decisions and next steps.' });
  expect(res.status).toBe(201);
  return (await res.json() as any).data.id as string;
}
async function projectKey(key: string, id: string, permission = 'write') {
  const res = await request(`/api/v1/projects/${id}/keys`, key, 'POST', { name: 'Agent', permission });
  expect(res.status).toBe(201);
  return (await res.json() as any).data;
}

async function createRole(key: string, id: string, name: string) {
  const res = await request(`/api/v1/projects/${id}/roles`, key, 'POST', { name, description: 'Project responsibility' });
  expect(res.status).toBe(201);
  return (await res.json() as any).data;
}
async function searchFixture(email: string) {
  const owner = await provision(email), project = await createProject(owner);
  const role = await createRole(owner, project, '开发');
  const writer = (await projectKey(owner, project)).api_key;
  const base = `/api/v1/projects/${project}/items`;
  const inputs = [
    { title: 'Older', kind: 'message', role_id: role.id, tags: ['API', 'urgent'] },
    { title: 'Middle B', kind: 'message', role_id: role.id, tags: ['api'] },
    { title: 'Middle A', kind: 'message', role_id: null, tags: ['urgent'] },
    { title: 'Latest note', kind: 'note', role_id: role.id, tags: ['api-v2'] },
  ];
  const times = ['2024-01-01T00:00:00.000Z', '2024-01-02T00:00:00.000Z', '2024-01-02T00:00:00.000Z', '2024-01-03T00:00:00.000Z'];
  const records = [];
  for (let i = 0; i < inputs.length; i++) {
    const res = await request(base, writer, 'POST', inputs[i]);
    expect(res.status).toBe(201);
    const item = (await res.json() as any).data;
    await env.DB.prepare('UPDATE items SET created_at = ? WHERE id = ?').bind(times[i], item.id).run();
    records.push({ ...item, created_at: times[i] });
  }
  return { owner, project, role, writer, base, records };
}

beforeAll(async () => {
  mf = new Miniflare({ workers: [{ config: {
    name: 'co-ai-test', compatibilityDate: '2026-10-11',
    manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: 'export default { fetch() { return new Response("test"); } }' } } },
    env: { DB: { type: 'd1', id: 'test-db' }, FILES: { type: 'r2', name: 'test-files' } },
  } }] });
  const bindings = await mf.getBindings();
  env = { ...bindings, ADMIN_TOKEN: admin, DOCS: { fetch: async (req: Request) => new Response(new URL(req.url).pathname.endsWith('.html') ? '<!doctype html><h1>AI docs</h1><a href="/llm/API.html">API</a>' : 'API docs', { headers: { 'Content-Type': new URL(req.url).pathname.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8' } }) } } as unknown as Env;
  // D1 exec expects each statement on one line.
  for (const file of ['0001_initial.sql', '0002_web_management.sql', '0003_roles_and_tags.sql', '0004_password_login.sql', '0005_recipient_roles.sql', '0006_oauth.sql', '0007_project_tables.sql', '0008_attachment_uploads.sql', '0009_mcp_events.sql', '0010_mcp_debug_logs.sql']) {
    if (file === '0004_password_login.sql') {
      const time = '2025-01-01T00:00:00.000Z';
      await env.DB.batch([
        env.DB.prepare('INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)').bind(migrationIds.users, 'legacy-migration@test.com', 'Legacy', time),
        env.DB.prepare('INSERT INTO api_keys (id, user_id, name, key_hash, permission, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(migrationIds.api_keys, migrationIds.users, 'Legacy Key', await digest('legacy-migration-key'), 'write', time),
        env.DB.prepare('INSERT INTO projects (id, owner_id, name, instructions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(migrationIds.projects, migrationIds.users, 'Legacy Project', 'Keep instructions', time, time),
        env.DB.prepare('INSERT INTO roles (id, project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind(migrationIds.roles, migrationIds.projects, 'Legacy Sender', time, time),
        env.DB.prepare('INSERT INTO items (id, project_id, title, content, version, role_id, tags, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(migrationIds.items, migrationIds.projects, 'Legacy Message', 'Keep content', 7, migrationIds.roles, '["stable"]', migrationIds.api_keys, migrationIds.api_keys, time, time),
        env.DB.prepare('INSERT INTO attachments (id, project_id, filename, object_key, content_type, size, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(migrationIds.attachments, migrationIds.projects, 'legacy.txt', 'migration/legacy.txt', 'text/plain', 6, migrationIds.api_keys, time),
      ]);
      await env.FILES.put('migration/legacy.txt', 'Legacy');
      for (const [table, id] of Object.entries(migrationIds)) migrationRows[table] = (await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first<Record<string, unknown>>())!;
    }
    const sql = await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8');
    if (file === '0009_mcp_events.sql') { await env.DB.exec(sql.replace(/\s+/g, ' ').trim()); continue; }
    await env.DB.exec(sql.replace(/^--.*$/gm, '').split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join(';\n') + ';');
  }
});

async function web(path: string, cookie?: string, method = 'GET', input?: unknown, origin = 'https://co-ai.test') {
  const headers: Record<string, string> = {};
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  if (input !== undefined) headers['Content-Type'] = 'application/json';
  return app.request('https://co-ai.test' + path, { method, headers, body: input === undefined ? undefined : JSON.stringify(input) }, env);
}
async function login(role: string, credential: string) {
  const res = await web('/api/web/login', undefined, 'POST', { role, credential });
  expect(res.status).toBe(200);
  const cookie = res.headers.get('Set-Cookie')!;
  expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('Secure'); expect(cookie).toContain('SameSite=Strict');
  expect(cookie).not.toContain(credential);
  return cookie.split(';')[0];
}

describe('HTTPS Web sessions and management', () => {
  it('forces HTTPS for Web, documents and ALL REST endpoints before any handler runs', async () => {
    for (const path of ['/', '/llm', '/llm/API.md']) {
      const res = await app.request('http://co-ai.test' + path, {}, env);
      expect(res.status).toBe(308); expect(res.headers.get('Location')).toBe('https://co-ai.test' + path);
    }
    for (const path of ['/api/web/login', '/api/admin/users', '/api/v1/projects/p/items', '/api/v1/projects/p/attachments', '/api/v1/projects/p/llm']) {
      const res = await app.request('http://co-ai.test' + path, { method: 'POST', body: 'not-json' }, env);
      expect(res.status).toBe(426); expect((await res.json() as any).error.message).toBe('HTTPS required');
    }
    expect((await request('/health')).headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
    expect((await request('/')).headers.get('Content-Security-Policy')).toContain("script-src 'self'");
  });

  it('creates secure opaque sessions, rejects CSRF and project key login, and revokes on logout', async () => {
    const key = await provision('web-session@test.com');
    const id = await createProject(key), agent = await projectKey(key, id);
    expect((await web('/api/web/login', undefined, 'POST', { role: 'user', credential: agent.api_key })).status).toBe(401);
    expect((await web('/api/web/login', undefined, 'POST', { role: 'user', credential: key }, 'https://evil.test')).status).toBe(403);
    const cookie = await login('user', key);
    expect((await web('/api/web/session', cookie)).status).toBe(200);
    expect((await web('/api/v1/projects', cookie)).status).toBe(200);
    expect((await web('/api/admin/users', cookie)).status).toBe(401);
    expect((await web('/api/v1/projects', cookie, 'POST', { name: 'CSRF' }, 'https://evil.test')).status).toBe(403);
    expect((await web('/api/v1/projects', cookie, 'POST', { name: 'CSRF' }, '')).status).toBe(403);
    expect((await web('/api/v1/projects', cookie, 'POST', { name: 'Web project' })).status).toBe(201);
    const sessionHash = await digest(cookie.split('=')[1]);
    expect(await env.DB.prepare('SELECT token_hash FROM web_sessions WHERE token_hash = ?').bind(sessionHash).first()).toBeTruthy();
    expect((await web('/api/web/logout', cookie, 'POST')).status).toBe(204);
    expect((await web('/api/web/session', cookie)).status).toBe(401);
    expect((await web('/api/v1/projects', cookie)).status).toBe(401);
    const expired = await login('user', key);
    await env.DB.prepare('UPDATE web_sessions SET expires_at = ? WHERE token_hash = ?').bind('2000-01-01T00:00:00.000Z', await digest(expired.split('=')[1])).run();
    expect((await web('/api/web/session', expired)).status).toBe(401);
  });

  it('lets administrators edit and disable users and rotate user keys while preserving project keys and data', async () => {
    const adminCookie = await login('admin', admin);
    expect((await web('/api/admin/users', adminCookie)).status).toBe(200);
    expect((await web('/api/v1/projects', adminCookie)).status).toBe(401);
    const created = await web('/api/admin/users', adminCookie, 'POST', { email: 'managed@test.com', name: 'Managed user' });
    expect(created.status).toBe(201);
    const { user, key } = (await created.json() as any).data;
    const userCookie = await login('user', key.api_key);
    const id = await createProject(key.api_key), agent = await projectKey(key.api_key, id);
    const updated = await web('/api/admin/users/' + user.id, adminCookie, 'PATCH', { name: 'Updated', email: 'updated@test.com' });
    expect(updated.status).toBe(200); expect((await updated.json() as any).data.name).toBe('Updated');
    expect((await web('/api/admin/users/' + user.id, adminCookie, 'PATCH', { disabled: true })).status).toBe(200);
    expect((await web('/api/web/session', userCookie)).status).toBe(401);
    expect((await request('/api/v1/projects', key.api_key)).status).toBe(401);
    expect((await request(`/api/v1/projects/${id}`, agent.api_key)).status).toBe(401);
    expect((await web('/api/web/login', undefined, 'POST', { role: 'user', credential: key.api_key })).status).toBe(401);
    expect((await web('/api/admin/users/' + user.id, adminCookie, 'PATCH', { disabled: false })).status).toBe(200);
    const freshSession = await login('user', key.api_key);
    const reset = await web('/api/admin/users/' + user.id + '/reset-key', adminCookie, 'POST');
    expect(reset.status).toBe(201);
    const newKey = (await reset.json() as any).data.api_key;
    expect((await web('/api/web/session', freshSession)).status).toBe(401);
    expect((await request('/api/v1/projects', key.api_key)).status).toBe(401);
    expect((await request(`/api/v1/projects/${id}`, agent.api_key)).status).toBe(200);
    expect((await request('/api/v1/projects', newKey)).status).toBe(200);
    const metadata = (await (await request('/api/v1/keys', newKey)).json() as any).data;
    expect(metadata.every((k: any) => !('api_key' in k) && !('key_hash' in k))).toBe(true);
    const oldToken = env.ADMIN_TOKEN;
    env.ADMIN_TOKEN = 'rotated-admin-secret-at-least-32-characters';
    expect((await web('/api/admin/users', adminCookie)).status).toBe(401);
    env.ADMIN_TOKEN = oldToken;
  });

  it('keeps project management isolated and suspends AI access to archived projects', async () => {
    const alice = await provision('web-alice@test.com'), bob = await provision('web-bob@test.com');
    const cookie = await login('user', alice), bobCookie = await login('user', bob);
    const id = await createProject(alice), agent = await projectKey(alice, id);
    expect((await web('/api/v1/projects/' + id, bobCookie, 'PATCH', { archived: true })).status).toBe(404);
    expect((await web('/api/v1/projects/' + id, cookie, 'PATCH', { archived: true })).status).toBe(200);
    expect((await request(`/api/v1/projects/${id}/llm`, agent.api_key)).status).toBe(404);
    expect((await (await web('/api/v1/projects', cookie)).json() as any).data).toHaveLength(0);
    expect((await (await web('/api/v1/projects?include_archived=true', cookie)).json() as any).data).toHaveLength(1);
    expect((await web('/api/v1/projects/' + id, cookie)).status).toBe(200);
    expect((await web('/api/v1/projects/' + id, cookie, 'PATCH', { archived: false })).status).toBe(200);
    expect((await request(`/api/v1/projects/${id}/llm`, agent.api_key)).status).toBe(200);
  });
});
afterAll(async () => { await mf?.dispose(); });

describe('multi-user project API with D1 and R2', () => {
  it('provides public documentation for authentication and permission failures', async () => {
    const owner = await provision('unauthorized-docs@test.com');
    const id = await createProject(owner);
    const reader = (await projectKey(owner, id, 'read')).api_key;
    const cases = [
      { response: await request('/api/v1/projects'), status: 401 },
      { response: await request('/api/v1/projects', 'invalid-key'), status: 401 },
      { response: await request('/api/admin/users', 'wrong'), status: 401 },
      { response: await web('/api/web/session'), status: 401 },
      { response: await request(`/api/v1/projects/${id}/items`, reader, 'POST', { title: 'Denied' }), status: 403 },
      { response: await request('/api/v1/projects', reader), status: 403 },
    ];
    for (const { response, status } of cases) {
      expect(response.status).toBe(status);
      expect(response.headers.get('Location')).toBeNull();
      const result = await response.json() as any;
      expect(result.error.code).toBe(status);
      expect(result.error.message).toBeTruthy();
      expect(result.error.documentation).toBe('https://co-ai.test/llm');
      const docs = await app.request(result.error.documentation, {}, env);
      expect(docs.status).toBe(200);
      expect(await docs.text()).toContain('<h1>AI docs</h1>');
    }
    const otherOrigin = await app.request('https://other.test/api/v1/projects?token=private', {}, env);
    expect((await otherOrigin.json() as any).error.documentation).toBe('https://other.test/llm');
    const missing = await request(`/api/v1/projects/${crypto.randomUUID()}`, reader);
    expect(missing.status).toBe(404);
    expect((await missing.json() as any).error.documentation).toBeUndefined();
  });

  it('requires credentials and rejects invalid provisioning / duplicate users', async () => {
    expect((await request('/api/v1/projects')).status).toBe(401);
    expect((await request('/api/admin/users', 'wrong', 'POST', { email: 'x@test.com', name: 'X' })).status).toBe(401);
    await provision('duplicate@test.com');
    expect((await request('/api/admin/users', admin, 'POST', { email: 'DUPLICATE@test.com', name: 'X' })).status).toBe(409);
    expect((await request('/api/admin/users', admin, 'POST', { email: 'invalid', name: 'X' })).status).toBe(400);
  });

  it('isolates users, projects, item IDs, key administration and read-only agents', async () => {
    const alice = await provision('alice@test.com'), bob = await provision('bob@test.com');
    const a = await createProject(alice), a2 = await createProject(alice), b = await createProject(bob);
    const write = await projectKey(alice, a), read = await projectKey(alice, a, 'read');
    expect((await request(`/api/v1/projects/${a}`, bob)).status).toBe(404);
    expect((await request(`/api/v1/projects/${a}/items`, bob, 'POST', { title: 'Intrusion' })).status).toBe(404);
    expect((await request(`/api/v1/projects/${a2}`, write.api_key)).status).toBe(404);
    expect((await request(`/api/v1/projects/${b}/attachments`, write.api_key)).status).toBe(404);
    expect((await request('/api/v1/projects', write.api_key)).status).toBe(403);
    expect((await request('/api/v1/keys', write.api_key)).status).toBe(403);
    expect((await request(`/api/v1/projects/${a}/keys`, write.api_key, 'POST', { name: 'Escalation' })).status).toBe(403);
    expect((await request(`/api/v1/projects/${a}`, write.api_key, 'PATCH', { name: 'Changed' })).status).toBe(403);
    expect((await request(`/api/v1/projects/${a}/items`, read.api_key, 'POST', { title: 'Denied' })).status).toBe(403);
    const list = await (await request('/api/v1/projects', alice)).json() as any;
    expect(list.data.map((p: any) => p.id).sort()).toEqual([a, a2].sort());
    const created = await (await request(`/api/v1/projects/${a}/items`, write.api_key, 'POST', { title: 'Task', kind: 'task' })).json() as any;
    expect((await request(`/api/v1/projects/${a2}/items/${created.data.id}`, alice)).status).toBe(404);
    expect((await request(`/api/v1/projects/${a}/items/${created.data.id}`, read.api_key)).status).toBe(200);
    expect((await request(`/api/v1/keys/${write.id}`, bob, 'DELETE')).status).toBe(404);
    expect((await request(`/api/v1/keys/${write.id}`, alice, 'DELETE')).status).toBe(204);
    expect((await request(`/api/v1/projects/${a}/items`, write.api_key)).status).toBe(401);
  });

  it('prevents lost updates, validates input, paginates and preserves deletion tombstones', async () => {
    const owner = await provision('writer@test.com'), id = await createProject(owner);
    const key = (await projectKey(owner, id)).api_key;
    const base = `/api/v1/projects/${id}/items`;
    expect((await request(base, key, 'POST', { title: '' })).status).toBe(400);
    expect((await request(base, key, 'POST', { title: 'X', unknown: 'X' })).status).toBe(400);
    const created = await request(base, key, 'POST', { title: 'Decision', content: 'Use Workers', kind: 'decision' });
    expect(created.status).toBe(201);
    const item = (await created.json() as any).data;
    expect(item.version).toBe(1);
    expect((await request(`${base}/${item.id}`, key, 'PATCH', { version: 1 })).status).toBe(400);
    expect((await request(`${base}/${item.id}`, key, 'PATCH', { content: 'Missing version' })).status).toBe(400);
    const [first, second] = await Promise.all([
      request(`${base}/${item.id}`, key, 'PATCH', { status: 'done', version: 1 }),
      request(`${base}/${item.id}`, key, 'PATCH', { content: 'Concurrent', version: 1 }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const updated = (await (await request(`${base}/${item.id}`, key)).json() as any).data;
    expect(updated.title).toBe('Decision');
    expect(updated.kind).toBe('decision');
    expect(updated.content).not.toBe('');
    expect((await request(`${base}/${item.id}`, key, 'DELETE', { version: 1 })).status).toBe(409);
    await request(base, key, 'POST', { title: 'Second' });
    const page = await (await request(base + '?limit=1', key)).json() as any;
    expect(page.data).toHaveLength(1);
    expect(page.next_cursor).toBeTruthy();
    const page2 = await (await request(base + '?limit=1&after=' + page.next_cursor, key)).json() as any;
    expect(page2.data).toHaveLength(1);
    expect(page2.data[0].id).not.toBe(page.data[0].id);
    expect(page2.next_cursor).toBeNull();
    expect((await request(base + '?limit=101', key)).status).toBe(400);
    expect((await request(`${base}/${item.id}`, key, 'DELETE', { version: 2 })).status).toBe(204);
    expect((await request(`${base}/${item.id}`, key)).status).toBe(404);
    const tombstones = await (await request(base + '?include_deleted=true', key)).json() as any;
    expect(tombstones.data.find((v: any) => v.id === item.id)).toMatchObject({ version: 3, deleted_at: expect.any(String) });
  });

  it('stores attachments in R2 and restricts download and deletion to their project', async () => {
    const owner = await provision('files@test.com'), id = await createProject(owner), other = await createProject(owner);
    const key = (await projectKey(owner, id)).api_key;
    const read = (await projectKey(owner, id, 'read')).api_key;
    const base = `/api/v1/projects/${id}/attachments`;
    const uploaded = await app.request(`https://co-ai.test${base}?filename=hello.txt`, {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'text/plain' }, body: 'Hello AI',
    }, env);
    expect(uploaded.status).toBe(201);
    const data = (await uploaded.json() as any).data;
    expect(data.size).toBe(8);
    const download = await request(`${base}/${data.id}`, read);
    expect(await download.text()).toBe('Hello AI');
    expect(download.headers.get('Content-Disposition')).toContain('attachment;');
    expect((await request(`/api/v1/projects/${other}/attachments/${data.id}`, owner)).status).toBe(404);
    expect((await request(`${base}/${data.id}`, read, 'DELETE')).status).toBe(403);
    expect((await request(`${base}/${data.id}`, key, 'DELETE')).status).toBe(204);
    expect((await request(`${base}/${data.id}`, key)).status).toBe(404);
    const userId = (await (await request('/api/v1/me', owner)).json() as any).data.id;
    expect((await env.FILES.list({ prefix: `${userId}/${id}/` })).objects).toHaveLength(0);
  });

  it('provides project-contained instructions and safely serves API docs', async () => {
    const owner = await provision('docs@test.com'), id = await createProject(owner);
    const key = (await projectKey(owner, id, 'read')).api_key;
    const doc = await (await request(`/api/v1/projects/${id}/llm`, key)).json() as any;
    expect(doc.data.project.instructions).toContain('Record decisions');
    expect(doc.data.base_url).toBe(`https://co-ai.test/api/v1/projects/${id}`);
    expect(doc.data.permission).toBe('read');
    expect((await request(`/api/v1/projects/${id}`, owner, 'PATCH', {})).status).toBe(400);
    const changed = await request(`/api/v1/projects/${id}`, owner, 'PATCH', { name: 'Renamed' });
    expect(changed.status).toBe(200);
    expect((await changed.json() as any).data.instructions).toBe('Record decisions and next steps.');
    for (const path of ['/llm', '/llm/', '/llm/API.html']) {
      const page = await request(path);
      expect(page.status).toBe(200);
      expect(page.headers.get('Location')).toBeNull();
      expect(page.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
      expect(page.headers.get('Content-Security-Policy')).toContain("script-src 'none'");
      expect(await page.text()).toContain('<h1>AI docs</h1>');
    }
    for (const path of ['/llm/README.md', '/llm/API.md']) {
      const docs = await request(path);
      expect(docs.status).toBe(200);
      expect(docs.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
      expect(await docs.text()).toBe('API docs');
    }
    expect(doc.data.documentation).toBe('https://co-ai.test/llm');
  });
});

describe('project roles, message TAGs and search windows', () => {
  it('isolates role management and preserves historical role attribution on archive', async () => {
    const owner = await provision('role-owner@test.com'), stranger = await provision('role-stranger@test.com');
    const id = await createProject(owner), other = await createProject(owner);
    const role = await createRole(owner, id, 'Developer');
    expect((await request(`/api/v1/projects/${id}/roles`, owner, 'POST', { name: 'developer' })).status).toBe(409);
    const writer = (await projectKey(owner, id)).api_key, reader = (await projectKey(owner, id, 'read')).api_key;
    expect((await request(`/api/v1/projects/${id}/roles`, reader)).status).toBe(200);
    expect((await request(`/api/v1/projects/${id}/roles`, writer, 'POST', { name: 'Intrusion' })).status).toBe(403);
    expect((await request(`/api/v1/projects/${id}/roles`, stranger)).status).toBe(404);
    expect((await request(`/api/v1/projects/${other}/roles/${role.id}`, owner, 'PATCH', { name: 'Cross project' })).status).toBe(404);
    expect((await request(`/api/v1/projects/${other}/items`, owner, 'POST', { title: 'Cross project role', role_id: role.id })).status).toBe(400);
    const res = await request(`/api/v1/projects/${id}/items`, writer, 'POST', { title: 'Role message', kind: 'message', role_id: role.id, tags: [' API ', 'api', 'Urgent'] });
    expect(res.status).toBe(201);
    const item = (await res.json() as any).data;
    expect(item).toMatchObject({ role_id: role.id, role_name: 'Developer', tags: ['api', 'urgent'] });
    expect((await request(`/api/v1/projects/${id}/roles/${role.id}`, owner, 'PATCH', { archived: true })).status).toBe(200);
    expect((await request(`/api/v1/projects/${id}/items`, writer, 'POST', { title: 'Archived role', role_id: role.id })).status).toBe(400);
    const updated = await request(`/api/v1/projects/${id}/items/${item.id}`, writer, 'PATCH', { version: 1, content: 'Keep role and TAGs' });
    expect(updated.status).toBe(200);
    expect((await updated.json() as any).data).toMatchObject({ role_id: role.id, tags: ['api', 'urgent'] });
    const cleared = await request(`/api/v1/projects/${id}/items/${item.id}`, writer, 'PATCH', { version: 2, role_id: null, tags: [] });
    expect(cleared.status).toBe(200);
    expect((await cleared.json() as any).data).toMatchObject({ role_id: null, role_name: null, tags: [] });
    expect((await (await request(`/api/v1/projects/${id}/roles`, reader)).json() as any).data).toHaveLength(0);
    expect((await (await request(`/api/v1/projects/${id}/roles?include_archived=true`, reader)).json() as any).data).toHaveLength(1);
    expect((await request(`/api/v1/projects/${id}/roles/${role.id}`, owner, 'PATCH', { archived: false, name: '工程师' })).status).toBe(200);
  });

  it('combines exact roles/TAGs, any/all TAG matching, kind and inclusive timezone-aware ranges', async () => {
    const { writer, base, role, records } = await searchFixture('search-filters@test.com');
    const query = async (params: string) => (await (await request(base + '?' + params, writer)).json() as any);
    expect((await query(`role_id=${role.id}&tag=API`)).data.map((i: any) => i.id).sort()).toEqual([records[0].id, records[1].id].sort());
    expect((await query('tag=api')).total_count).toBe(2); // api-v2 must not match api.
    expect((await query('tag=api&tag=urgent')).data.map((i: any) => i.id)).toEqual([records[0].id]);
    expect((await query('tag=api&tag=urgent&tag_mode=any')).total_count).toBe(3);
    expect((await query('role_id=none')).data.map((i: any) => i.id)).toEqual([records[2].id]);
    const boundary = encodeURIComponent('2024-01-02T08:00:00+08:00');
    expect((await query(`from=${boundary}&to=${boundary}&kind=message`)).data.map((i: any) => i.id).sort()).toEqual([records[1].id, records[2].id].sort());
    expect((await query(`role_id=${role.id}&tag=api&from=${boundary}&q=Middle&kind=message`)).data.map((i: any) => i.id)).toEqual([records[1].id]);
    expect((await query('q=%25')).data).toHaveLength(0); // '%' is literal text, not a SQL wildcard.
    expect((await query('tag=' + encodeURIComponent("x' OR 1=1--"))).data).toHaveLength(0);
  });

  it('caps total results across chronological pages and safely breaks timestamp ties', async () => {
    const { writer, base, records } = await searchFixture('search-pages@test.com');
    const sorted = [...records].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
    const first = await (await request(base + '?max_items=3&limit=2', writer)).json() as any;
    expect(first.total_count).toBe(4); expect(first.data.map((v: any) => v.id)).toEqual(sorted.slice(0, 2).map(v => v.id));
    expect(first.next_cursor).toBeTruthy();
    const second = await (await request(base + '?max_items=3&limit=2&after=' + first.next_cursor, writer)).json() as any;
    expect(second.data.map((v: any) => v.id)).toEqual([sorted[2].id]); expect(second.next_cursor).toBeNull();
    expect((await request(base + '?max_items=3&limit=2&tag=api&after=' + first.next_cursor, writer)).status).toBe(400);
    const oldest = await (await request(base + '?order=oldest&limit=1', writer)).json() as any;
    expect(oldest.data[0].id).toBe(records[0].id);
    const next = await (await request(base + '?order=oldest&limit=1&after=' + oldest.next_cursor, writer)).json() as any;
    expect(next.data[0].id).toBe(sorted[2].id);
    const single = await (await request(base + '?max_items=1', writer)).json() as any;
    expect(single.data.map((v: any) => v.id)).toEqual([records[3].id]); expect(single.next_cursor).toBeNull();
  });

  it('rejects malformed search parameters and leaves role/TAG metadata untouched on stale updates', async () => {
    const { writer, base, role, records } = await searchFixture('search-invalid@test.com');
    for (const query of ['from=2024-01-01', 'to=not-a-time', 'from=2024-01-03T00:00:00Z&to=2024-01-01T00:00:00Z', 'max_items=0', 'max_items=1001', 'tag=', 'tag_mode=unknown', 'order=unknown', 'role_id=invalid', 'after=broken&order=newest']) {
      expect((await request(base + '?' + query, writer)).status, query).toBe(400);
    }
    expect((await request(base, writer, 'POST', { title: 'Invalid tags', tags: Array.from({ length: 21 }, (_, i) => 'tag' + i) })).status).toBe(400);
    expect((await request(base, writer, 'POST', { title: 'Empty tags', tags: [' '] })).status).toBe(400);
    const item = records[0];
    expect((await request(`${base}/${item.id}`, writer, 'PATCH', { version: 1, content: 'Updated' })).status).toBe(200);
    expect((await request(`${base}/${item.id}`, writer, 'PATCH', { version: 1, role_id: null, tags: [] })).status).toBe(409);
    expect((await (await request(`${base}/${item.id}`, writer)).json() as any).data).toMatchObject({ role_id: role.id, tags: ['api', 'urgent'] });
    expect((await request(`${base}/${item.id}`, writer, 'DELETE', { version: 2 })).status).toBe(204);
    const deleted = await (await request(base + '?include_deleted=true&tag=urgent', writer)).json() as any;
    expect(deleted.data.find((i: any) => i.id === item.id).deleted_at).toBeTruthy();
  });
});

describe('username/password management', () => {
  const password = 'initial-password-123';
  const nextPassword = 'changed-password-456';
  async function passwordLogin(username: string, secret = password) {
    return web('/api/web/login', undefined, 'POST', { role: 'user', username, password: secret });
  }
  function cookie(res: Response) {
    expect(res.status).toBe(200);
    const value = res.headers.get('Set-Cookie')!;
    expect(value).toContain('HttpOnly'); expect(value).toContain('Secure'); expect(value).toContain('SameSite=Strict');
    return value.split(';')[0];
  }
  it('supports password login, editing and key rotation without changing project records or AI access', async () => {
    const owner = await provision('password-owner@test.com');
    const ownerCookie = await login('user', owner);
    const project = await createProject(owner), role = await createRole(owner, project, 'Writer');
    const agent = (await projectKey(owner, project)).api_key;
    const base = `/api/v1/projects/${project}`;
    const item = await request(base + '/items', agent, 'POST', { title: 'Preserve this', content: 'Context', role_id: role.id, tags: ['Stable'] });
    expect(item.status).toBe(201);
    const attachment = await app.request(`https://co-ai.test${base}/attachments?filename=keep.txt`, { method: 'POST', headers: { Authorization: `Bearer ${agent}`, 'Content-Type': 'text/plain' }, body: 'Keep attachment' }, env);
    expect(attachment.status).toBe(201);
    const attachmentId = (await attachment.json() as any).data.id;
    const snapshot = async () => {
      const tables = ['projects', 'roles', 'items', 'attachments'];
      return Promise.all(tables.map((table) => env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
    };
    const original = await snapshot();
    expect((await web('/api/web/credentials', ownerCookie, 'PUT', { username: 'Alice_Login', password })).status).toBe(204);
    const stored = await env.DB.prepare('SELECT username, password_hash FROM users WHERE email = ?').bind('password-owner@test.com').first<any>();
    expect(stored.username).toBe('alice_login'); expect(stored.password_hash).not.toContain(password); expect(stored.password_hash).toMatch(/^pbkdf2-sha256\$100000\$/);
    expect((await passwordLogin('alice_login', 'wrong-password')).status).toBe(401);
    expect((await passwordLogin('missing-user', password)).status).toBe(401);
    expect((await web('/api/web/login', undefined, 'POST', { role: 'user', username: 'alice_login', password }, 'https://evil.test')).status).toBe(403);
    const session = cookie(await passwordLogin('ALICE_LOGIN'));
    expect((await web('/api/v1/projects', session)).status).toBe(200);
    expect((await web('/api/admin/users', session)).status).toBe(401);
    const me = (await (await web('/api/v1/me', session)).json() as any).data;
    expect(me).not.toHaveProperty('password_hash');
    const keys = (await (await web('/api/v1/keys', session)).json() as any).data;
    expect(keys).toHaveLength(2);
    const actor = await env.DB.prepare("SELECT id, key_hash FROM api_keys WHERE user_id = ? AND kind = 'password'").bind(me.id).first<any>();
    expect((await web('/api/v1/keys/' + actor.id, session, 'DELETE')).status).toBe(404);
    expect((await request('/api/v1/projects', actor.key_hash)).status).toBe(401);
    expect((await web('/api/web/credentials', session, 'PUT', { username: 'alice_login', password: nextPassword, current_password: 'wrong' })).status).toBe(403);
    expect((await web('/api/web/credentials', session, 'PUT', { username: 'alice_login', password: nextPassword, current_password: password })).status).toBe(204);
    expect((await web('/api/web/session', session)).status).toBe(401);
    expect((await passwordLogin('alice_login', password)).status).toBe(401);
    const fresh = cookie(await passwordLogin('alice_login', nextPassword));
    const reset = await web('/api/web/reset-key', fresh, 'POST');
    expect(reset.status).toBe(201);
    const newKey = (await reset.json() as any).data.api_key;
    expect((await request('/api/v1/projects', owner)).status).toBe(401);
    expect((await web('/api/web/session', ownerCookie)).status).toBe(401);
    expect((await web('/api/web/session', fresh)).status).toBe(200);
    expect((await request('/api/v1/projects', newKey)).status).toBe(200);
    expect((await request(base, agent)).status).toBe(200);
    expect(await (await request(base + '/attachments/' + attachmentId, agent)).text()).toBe('Keep attachment');
    const updated = await snapshot();
    expect(updated.map((r) => r.results)).toEqual(original.map((r) => r.results));
    // Password-authenticated writes retain stable foreign-key attribution after password/key changes.
    expect((await web(base + '/items', fresh, 'POST', { title: 'Password-authored' })).status).toBe(201);
    const authored = await env.DB.prepare('SELECT created_by FROM items WHERE title = ?').bind('Password-authored').first<any>();
    expect(authored.created_by).toBe(actor.id);
    const upload = await app.request(`https://co-ai.test${base}/attachments?filename=password.txt`, { method: 'POST', headers: { Cookie: fresh, Origin: 'https://co-ai.test' }, body: 'Password upload' }, env);
    expect(upload.status).toBe(201);
    const other = await provision('password-other@test.com');
    const otherCookie = await login('user', other);
    expect((await web('/api/web/credentials', otherCookie, 'PUT', { username: 'ALICE_LOGIN', password })).status).toBe(409);
    expect((await web(base, otherCookie)).status).toBe(404);
    expect((await web('/api/web/credentials', undefined, 'PUT', { username: 'other', password })).status).toBe(401);
  });

  it('lets admins provision/reset credentials and preserves password sessions on user-key reset', async () => {
    const adminCookie = await login('admin', admin);
    const created = await web('/api/admin/users', adminCookie, 'POST', { email: 'password-managed@test.com', name: 'Managed', username: 'managed-login', password });
    expect(created.status).toBe(201);
    const { user, key } = (await created.json() as any).data;
    expect(JSON.stringify(user)).not.toContain('password_hash');
    const session = cookie(await passwordLogin('managed-login'));
    const project = await createProject(key.api_key), agent = (await projectKey(key.api_key, project)).api_key;
    expect((await web('/api/admin/users/' + user.id + '/reset-key', adminCookie, 'POST')).status).toBe(201);
    expect((await web('/api/web/session', session)).status).toBe(200);
    expect((await web('/api/admin/users/' + user.id, adminCookie, 'PATCH', { username: 'renamed-login', password: nextPassword })).status).toBe(200);
    expect((await web('/api/web/session', session)).status).toBe(401);
    expect((await passwordLogin('managed-login')).status).toBe(401);
    const fresh = cookie(await passwordLogin('renamed-login', nextPassword));
    expect((await request(`/api/v1/projects/${project}`, agent)).status).toBe(200);
    expect((await web('/api/admin/users/' + user.id, adminCookie, 'PATCH', { disabled: true })).status).toBe(200);
    expect((await passwordLogin('renamed-login', nextPassword)).status).toBe(401);
    expect((await web('/api/web/session', fresh)).status).toBe(401);
    expect((await web('/api/admin/users/' + user.id, adminCookie, 'PATCH', { disabled: false })).status).toBe(200);
    expect((await web('/api/web/session', fresh)).status).toBe(401);
    cookie(await passwordLogin('renamed-login', nextPassword));
    expect((await web('/api/admin/users', adminCookie, 'POST', { email: 'duplicate-login@test.com', name: 'Duplicate', username: 'RENAMED-LOGIN', password })).status).toBe(409);
    expect((await web('/api/admin/users', adminCookie, 'POST', { email: 'short-password@test.com', name: 'Short', username: 'short-login', password: 'short' })).status).toBe(400);
    expect((await web('/api/admin/users', adminCookie, 'POST', { email: 'incomplete-login@test.com', name: 'Incomplete', username: 'incomplete-login' })).status).toBe(400);
    const legacy = await provision('password-legacy@test.com');
    const legacyId = (await (await request('/api/v1/me', legacy)).json() as any).data.id;
    expect((await web('/api/admin/users/' + legacyId, adminCookie, 'PATCH', { password })).status).toBe(400);
    expect((await web('/api/admin/users/' + legacyId, adminCookie, 'PATCH', { username: 'legacy-login', password })).status).toBe(200);
    cookie(await passwordLogin('legacy-login'));
  });

  it('limits password login attempts and allows retries after the window expires', async () => {
    for (let i = 0; i < 10; i++) expect((await passwordLogin('limited-login', 'wrong')).status).toBe(401);
    expect((await passwordLogin('limited-login', 'wrong')).status).toBe(429);
    await env.DB.prepare('UPDATE login_attempts SET expires_at = 0').run();
    expect((await passwordLogin('limited-login', 'wrong')).status).toBe(401);
  });
});

describe('sender and recipient roles', () => {
  it('supports multiple project recipients, ALL broadcasts and combined sender/recipient search', async () => {
    const owner = await provision('recipients@test.com'), project = await createProject(owner);
    const sender = await createRole(owner, project, 'Developer'), tester = await createRole(owner, project, 'Tester'), manager = await createRole(owner, project, 'Manager');
    const agent = (await projectKey(owner, project)).api_key;
    const base = `/api/v1/projects/${project}/items`;
    const create = async (title: string, recipients?: string[]) => {
      const res = await request(base, agent, 'POST', { title, kind: 'message', role_id: sender.id, ...(recipients ? { recipient_role_ids: recipients } : {}), tags: ['api'] });
      expect(res.status).toBe(201); return (await res.json() as any).data;
    };
    const directed = await create('Directed', [tester.id, manager.id, tester.id]);
    expect(directed.role_id).toBe(sender.id); expect(directed.role_name).toBe('Developer');
    expect(directed.recipient_role_ids).toEqual([tester.id, manager.id]);
    expect(directed.recipient_roles).toEqual([{ id: tester.id, name: 'Tester' }, { id: manager.id, name: 'Manager' }]);
    const broadcast = await create('Broadcast');
    expect(broadcast.recipient_role_ids).toEqual(['ALL']); expect(broadcast.recipient_roles).toEqual([{ id: 'ALL', name: 'ALL' }]);
    await create('Sender only', [sender.id]);
    const search = async (query: string) => {
      const res = await request(base + '?' + query, agent); expect(res.status).toBe(200); return (await res.json() as any);
    };
    const inbox = await search(`recipient_role_id=${tester.id}&role_id=${sender.id}&tag=api&kind=message&order=newest&limit=1&max_items=2`);
    expect(inbox.total_count).toBe(2); expect(inbox.data).toHaveLength(1); expect(inbox.next_cursor).toBeTruthy();
    const second = await search(`recipient_role_id=${tester.id}&role_id=${sender.id}&tag=api&kind=message&order=newest&limit=1&max_items=2&after=${inbox.next_cursor}`);
    expect(new Set([inbox.data[0].id, second.data[0].id])).toEqual(new Set([directed.id, broadcast.id]));
    expect(second.next_cursor).toBeNull();
    expect((await request(base + `?recipient_role_id=${manager.id}&order=newest&after=${inbox.next_cursor}`, agent)).status).toBe(400);
    expect((await search('recipient_role_id=ALL')).data.map((i: any) => i.id)).toEqual([broadcast.id]);
    expect((await search(`recipient_role_id=${sender.id}`)).total_count).toBe(2);
    const otherProject = await createProject(owner), foreign = await createRole(owner, otherProject, 'Foreign');
    for (const recipients of [[], ['all'], ['invalid'], [foreign.id], ['ALL', foreign.id], Array(21).fill('ALL'), null]) {
      expect((await request(base, agent, 'POST', { title: 'Invalid', recipient_role_ids: recipients })).status).toBe(400);
    }
    expect((await request(base + '?recipient_role_id=none', agent)).status).toBe(400);
    const reader = (await projectKey(owner, project, 'read')).api_key;
    expect((await request(base, reader, 'POST', { title: 'Forbidden', recipient_role_ids: ['ALL'] })).status).toBe(403);
    const update = await request(base + '/' + directed.id, agent, 'PATCH', { version: directed.version, recipient_role_ids: ['ALL', tester.id] });
    expect(update.status).toBe(200); expect((await update.json() as any).data.recipient_role_ids).toEqual(['ALL', tester.id]);
    expect((await request(base + '/' + directed.id, agent, 'PATCH', { version: directed.version, recipient_role_ids: [manager.id] })).status).toBe(409);
    expect((await (await request(base + '/' + directed.id, agent)).json() as any).data.recipient_role_ids).toEqual(['ALL', tester.id]);
  });

  it('preserves archived recipient labels and keeps addressing independent of access permissions', async () => {
    const owner = await provision('archived-recipient@test.com'), project = await createProject(owner);
    const recipient = await createRole(owner, project, 'Reviewer'), agent = (await projectKey(owner, project)).api_key;
    const base = `/api/v1/projects/${project}`;
    const created = await request(base + '/items', agent, 'POST', { title: 'Historical', recipient_role_ids: [recipient.id] });
    const item = (await created.json() as any).data;
    expect((await request(base + '/roles/' + recipient.id, owner, 'PATCH', { archived: true })).status).toBe(200);
    const read = (await (await request(base + '/items/' + item.id, agent)).json() as any).data;
    expect(read.recipient_roles).toEqual([{ id: recipient.id, name: 'Reviewer' }]);
    expect((await request(base + '/items', agent, 'POST', { title: 'New', recipient_role_ids: [recipient.id] })).status).toBe(400);
    expect((await request(base + '/items/' + item.id, agent, 'PATCH', { version: 1, content: 'Updated history' })).status).toBe(200);
    const result = (await (await request(base + '/items?recipient_role_id=' + recipient.id, agent)).json() as any);
    expect(result.data[0].recipient_role_ids).toEqual([recipient.id]); expect(result.data[0].version).toBe(2);
    const other = await provision('private-recipient@test.com');
    expect((await request(base + '/items/' + item.id, other)).status).toBe(404);
    // ALL remains a message address and grants no access to another project.
    const broadcast = (await (await request(base + '/items', agent, 'POST', { title: 'Private broadcast', recipient_role_ids: ['ALL'] })).json() as any).data;
    expect((await request(base + '/items/' + broadcast.id, other)).status).toBe(404);
  });
});

describe('existing database migration compatibility', () => {
  it('preserves existing users, keys, project data, sender roles and attachments', async () => {
    for (const [table, id] of Object.entries(migrationIds)) {
      const row = (await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first<Record<string, unknown>>())!;
      for (const [key, value] of Object.entries(migrationRows[table])) expect(row[key]).toEqual(value);
      if (table === 'users') { expect(row.username).toBeNull(); expect(row.password_hash).toBeNull(); }
      if (table === 'api_keys') expect(row.kind).toBe('api');
      if (table === 'items') expect(JSON.parse(row.recipient_role_ids as string)).toEqual(['ALL']);
    }
    expect(await (await env.FILES.get('migration/legacy.txt'))!.text()).toBe('Legacy');
    expect((await request('/api/v1/projects', 'legacy-migration-key')).status).toBe(200);
  });
});

describe('updated-since polling', () => {
  it('finds edits to older tasks, combines filters, normalizes timezone boundaries and includes deletion tombstones when requested', async () => {
    const owner = await provision('updated-task@test.com'), project = await createProject(owner);
    const role = await createRole(owner, project, 'Developer'), recipient = await createRole(owner, project, 'Reviewer');
    const writer = (await projectKey(owner, project)).api_key, reader = (await projectKey(owner, project, 'read')).api_key;
    const base = `/api/v1/projects/${project}/items`;
    const created = (await (await request(base, writer, 'POST', { title: 'Watched task', kind: 'task', role_id: role.id, recipient_role_ids: [recipient.id], tags: ['watch'] })).json() as any).data;
    await env.DB.prepare('UPDATE items SET created_at = ?, updated_at = ? WHERE id = ?').bind('2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', created.id).run();
    const edit = await request(base + '/' + created.id, writer, 'PATCH', { version: 1, status: 'in_progress', content: 'Task changed' });
    expect(edit.status).toBe(200);
    const edited = (await edit.json() as any).data;
    expect((await (await request(base + '?from=2024-01-01T00:00:00Z', reader)).json() as any).data).toHaveLength(0);
    const query = `updated_since=${encodeURIComponent(edited.updated_at)}&kind=task&role_id=${role.id}&recipient_role_id=${recipient.id}&tag=watch`;
    const poll = await request(base + '?' + query, reader);
    expect(poll.status).toBe(200);
    const result = await poll.json() as any;
    expect(result.data).toHaveLength(1); expect(result.data[0]).toMatchObject({ id: created.id, version: 2, status: 'in_progress' });
    expect(Date.parse(result.sync_until)).toBeGreaterThanOrEqual(Date.parse(edited.updated_at));
    const offsetBoundary = edited.updated_at.replace('Z', '+00:00');
    expect((await (await request(base + '?updated_since=' + encodeURIComponent(offsetBoundary), reader)).json() as any).data[0].id).toBe(created.id);
    expect((await (await request(base + '?' + query + '&from=2024-01-01T00:00:00Z', reader)).json() as any).data).toHaveLength(0);
    expect((await request(base + '/' + created.id, writer, 'DELETE', { version: 2 })).status).toBe(204);
    expect((await (await request(base + '?' + query, reader)).json() as any).data).toHaveLength(0);
    const deleted = (await (await request(base + '?' + query + '&include_deleted=true', reader)).json() as any).data;
    expect(deleted[0]).toMatchObject({ id: created.id, version: 3, deleted_at: expect.any(String) });
    const other = await provision('updated-other@test.com');
    expect((await request(base + '?' + query, other)).status).toBe(404);
    for (const invalid of ['', '2024-01-01', '2024-01-01T00:00:00', 'invalid']) expect((await request(base + '?updated_since=' + encodeURIComponent(invalid), reader)).status).toBe(400);
    expect((await (await request(base + '?include_deleted=true', reader)).json() as any).sync_until).toBeNull();
  });

  it('paginates tied update times in both directions and binds cursors to the updated-since window', async () => {
    const owner = await provision('updated-pages@test.com'), project = await createProject(owner);
    const writer = (await projectKey(owner, project)).api_key, base = `/api/v1/projects/${project}/items`;
    const times = ['2024-01-02T00:00:00.000Z', '2024-01-02T00:00:00.000Z', '2024-01-03T00:00:00.000Z', '2024-01-04T00:00:00.000Z'];
    const records = [];
    for (let i = 0; i < times.length; i++) {
      const item = (await (await request(base, writer, 'POST', { title: 'Task ' + i, kind: 'task' })).json() as any).data;
      await env.DB.prepare('UPDATE items SET created_at = ?, updated_at = ? WHERE id = ?').bind('2020-01-01T00:00:00.000Z', times[i], item.id).run();
      records.push({ id: item.id, updated_at: times[i] });
    }
    const sorted = [...records].sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.id.localeCompare(b.id));
    const query = 'updated_since=2024-01-02T08:00:00%2B08:00&kind=task';
    const first = await (await request(base + '?' + query + '&limit=1', writer)).json() as any;
    expect(first.data[0].id).toBe(sorted[0].id); expect(first.total_count).toBe(4); expect(first.next_cursor).toBeTruthy();
    const second = await (await request(base + '?' + query + '&limit=2&after=' + first.next_cursor, writer)).json() as any;
    expect(second.data.map((i: any) => i.id)).toEqual(sorted.slice(1, 3).map((i) => i.id)); expect(second.sync_until).toBe(first.sync_until);
    const third = await (await request(base + '?' + query + '&limit=2&after=' + second.next_cursor, writer)).json() as any;
    expect(third.data.map((i: any) => i.id)).toEqual([sorted[3].id]); expect(third.next_cursor).toBeNull(); expect(third.sync_until).toBe(first.sync_until);
    const latest = await (await request(base + '?' + query + '&order=updated_newest&limit=2&max_items=3', writer)).json() as any;
    expect(latest.data.map((i: any) => i.id)).toEqual(sorted.slice(2).reverse().map((i) => i.id));
    const last = await (await request(base + '?' + query + '&order=updated_newest&limit=2&max_items=3&after=' + latest.next_cursor, writer)).json() as any;
    expect(last.data[0].id).toBe(sorted[1].id); expect(last.next_cursor).toBeNull(); expect(last.total_count).toBe(4);
    expect((await request(base + '?updated_since=2024-01-01T00:00:00Z&kind=task&after=' + first.next_cursor, writer)).status).toBe(400);
    expect((await request(base + '?' + query + '&order=updated_newest&after=' + first.next_cursor, writer)).status).toBe(400);
    expect((await request(base + '?' + query + '&order=id&after=' + sorted[0].id, writer)).status).toBe(400);
    const legacy = await (await request(base + '?order=id&limit=1', writer)).json() as any;
    expect(legacy.next_cursor).toMatch(/^[a-f0-9-]{36}$/);
    const updatedOrder = await (await request(base + '?order=updated_oldest&limit=1', writer)).json() as any;
    expect(updatedOrder.data[0].id).toBe(sorted[0].id); expect(updatedOrder.sync_until).toBeTruthy();
  });

  it('defers tasks edited during pagination to the next polling window and returns a checkpoint even when empty', async () => {
    const owner = await provision('updated-live@test.com'), project = await createProject(owner);
    const writer = (await projectKey(owner, project)).api_key, base = `/api/v1/projects/${project}/items`;
    const items = [];
    for (let i = 0; i < 2; i++) {
      const item = (await (await request(base, writer, 'POST', { title: 'Live task ' + i, kind: 'task' })).json() as any).data;
      await env.DB.prepare('UPDATE items SET created_at = ?, updated_at = ? WHERE id = ?').bind('2020-01-01T00:00:00.000Z', `2024-01-0${i + 2}T00:00:00.000Z`, item.id).run();
      items.push(item);
    }
    const query = 'updated_since=2024-01-01T00:00:00Z&kind=task&limit=1';
    const first = await (await request(base + '?' + query, writer)).json() as any;
    expect(first.data[0].id).toBe(items[0].id);
    await new Promise((resolve) => setTimeout(resolve, 2));
    const edited = (await (await request(base + '/' + items[1].id, writer, 'PATCH', { version: 1, content: 'Changed while paging' })).json() as any).data;
    expect(Date.parse(edited.updated_at)).toBeGreaterThan(Date.parse(first.sync_until));
    const rest = await (await request(base + '?' + query + '&after=' + first.next_cursor, writer)).json() as any;
    expect(rest.data).toHaveLength(0); expect(rest.next_cursor).toBeNull(); expect(rest.sync_until).toBe(first.sync_until);
    const next = await (await request(base + '?kind=task&updated_since=' + encodeURIComponent(first.sync_until), writer)).json() as any;
    expect(next.data.map((i: any) => i.id)).toEqual([items[1].id]); expect(next.data[0].version).toBe(2);
    const empty = await (await request(base + '?updated_since=2099-01-01T00:00:00Z', writer)).json() as any;
    expect(empty.data).toHaveLength(0); expect(empty.sync_until).toBeTruthy();
  });
});

async function mcpTool(name: string, args: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const response = await app.request('https://co-ai.test/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }, env);
  if (response.status === 401 || response.status === 403) return { status: response.status, body: await response.json(), isError: true, response };
  expect(response.status).toBe(200);
  const message = await response.json() as any;
  expect(message.error, name).toBeUndefined();
  return { ...message.result.structuredContent, isError: message.result.isError, response };
}

const mcpBearer = (key: string) => ({ Authorization: `Bearer ${key}` });

describe('temporary attachment upload capabilities', () => {
  const createUpload = async (key: string, projectId: string, fields: Record<string, unknown> = {}) => {
    const result = await request(`/api/v1/projects/${projectId}/attachments/uploads`, key, 'POST', { filename: 'recording.mp3', content_type: 'audio/mpeg', ...fields });
    expect(result.status).toBe(201);
    return (await result.json() as any).data;
  };
  const transfer = (ticket: any, bytes: Uint8Array, bindings = env, contentType = ticket.headers['Content-Type']) => app.request(ticket.upload_url, {
    method: 'PUT', headers: { 'Content-Type': contentType, Origin: 'https://grok.com' }, body: bytes,
  }, bindings);

  it('creates links through MCP and uploads a 5.2 MB file without Base64 or Bearer credentials', async () => {
    const owner = await provision('upload-mcp@test.com'), projectId = await createProject(owner);
    const key = await projectKey(owner, projectId);
    const bytes = new Uint8Array(5_200_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const created = await mcpTool('createAttachmentUpload', { projectId, body: { filename: 'recording.mp3', content_type: 'audio/mpeg', size: bytes.byteLength } }, mcpBearer(key.api_key));
    expect(created.status).toBe(201);
    const ticket = created.body.data;
    expect(ticket.method).toBe('PUT'); expect(ticket.max_size).toBe(10 * 1024 * 1024);
    expect(Date.parse(ticket.expires_at) - Date.now()).toBeLessThanOrEqual(600_000);
    const token = new URL(ticket.upload_url).pathname.split('/').at(-1)!;
    const row = await env.DB.prepare('SELECT token_hash FROM attachment_uploads WHERE attachment_id = ?').bind(ticket.attachment_id).first<{ token_hash: string }>();
    expect(row!.token_hash).toBe(await digest(token)); expect(row!.token_hash).not.toBe(token);
    const response = await transfer(ticket, bytes);
    expect(response.status).toBe(201); expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect((await response.json() as any).data).toMatchObject({ id: ticket.attachment_id, filename: 'recording.mp3', size: bytes.length, created_by: key.id, content_type: 'audio/mpeg' });
    const download = await request(`/api/v1/projects/${projectId}/attachments/${ticket.attachment_id}`, key.api_key);
    expect(await crypto.subtle.digest('SHA-256', await download.arrayBuffer())).toEqual(await crypto.subtle.digest('SHA-256', bytes));
    expect((await transfer(ticket, bytes)).status).toBe(404);
    const stranger = await provision('upload-stranger@test.com');
    expect((await request(`/api/v1/projects/${projectId}/attachments/${ticket.attachment_id}`, stranger)).status).toBe(404);
    const options = await app.request(ticket.upload_url, { method: 'OPTIONS', headers: { Origin: 'https://grok.com' } }, env);
    expect(options.status).toBe(204); expect(options.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
    expect((await app.request(ticket.upload_url.replace('https:', 'http:'), { method: 'PUT', body: bytes }, env)).status).toBe(426);
  });

  it('enforces write permission and project boundaries before issuing links', async () => {
    const owner = await provision('upload-permissions@test.com'), projectId = await createProject(owner), other = await createProject(owner);
    const read = await projectKey(owner, projectId, 'read'), write = await projectKey(owner, projectId);
    expect((await request(`/api/v1/projects/${projectId}/attachments/uploads`, read.api_key, 'POST', { filename: 'file.bin' })).status).toBe(403);
    expect((await request(`/api/v1/projects/${other}/attachments/uploads`, write.api_key, 'POST', { filename: 'file.bin' })).status).toBe(404);
    for (const fields of [{ filename: '../file' }, { size: 10 * 1024 * 1024 + 1 }, { content_type: 'audio/mpeg\r\nX-Header: bad' }]) {
      expect((await request(`/api/v1/projects/${projectId}/attachments/uploads`, write.api_key, 'POST', { filename: 'file.bin', ...fields })).status).toBe(400);
    }
    const cookie = await login('user', owner), clientId = await registerOAuth('Upload permission'), resource = 'https://co-ai.test/mcp';
    const tokens = await oauthTokens(clientId, await approveOAuth(await startOAuth(clientId, cookie, resource, 'read'), cookie, projectId), resource);
    const denied = await mcpTool('createAttachmentUpload', { projectId, body: { filename: 'file.bin' } }, mcpBearer(tokens.access_token));
    expect(denied.status).toBe(403); expect(denied.response.headers.get('WWW-Authenticate')).toContain('scope="write"');
  });

  it('rejects expired, revoked, disabled and archived upload authorizations, including OAuth revocation', async () => {
    const owner = await provision('upload-revocation@test.com'), projectId = await createProject(owner), key = await projectKey(owner, projectId);
    const expired = await createUpload(key.api_key, projectId);
    await env.DB.prepare('UPDATE attachment_uploads SET expires_at = ? WHERE attachment_id = ?').bind('2000-01-01T00:00:00Z', expired.attachment_id).run();
    expect((await transfer(expired, new Uint8Array([1]))).status).toBe(404);
    const revoked = await createUpload(key.api_key, projectId);
    await request(`/api/v1/keys/${key.id}`, owner, 'DELETE');
    expect((await transfer(revoked, new Uint8Array([1]))).status).toBe(404);
    const archived = await createUpload(owner, projectId);
    await request(`/api/v1/projects/${projectId}`, owner, 'PATCH', { archived: true });
    expect((await transfer(archived, new Uint8Array([1]))).status).toBe(404);
    await request(`/api/v1/projects/${projectId}`, owner, 'PATCH', { archived: false });
    const cookie = await login('user', owner), clientId = await registerOAuth('Upload revocation'), resource = 'https://co-ai.test/mcp';
    const tokens = await oauthTokens(clientId, await approveOAuth(await startOAuth(clientId, cookie, resource, 'write'), cookie, projectId), resource);
    const oauthTicket = (await mcpTool('createAttachmentUpload', { projectId, body: { filename: 'file.bin' } }, mcpBearer(tokens.access_token))).body.data;
    await oauthForm('/oauth/revoke', { client_id: clientId, token: tokens.access_token });
    expect((await transfer(oauthTicket, new Uint8Array([1]))).status).toBe(404);
    const disabled = await createUpload(owner, projectId);
    const me = await (await request('/api/v1/me', owner)).json() as any;
    await request(`/api/admin/users/${me.data.id}`, admin, 'PATCH', { disabled: true });
    expect((await transfer(disabled, new Uint8Array([1]))).status).toBe(404);
  });

  it('allows retries after size or storage failures and consumes a link only once under concurrency', async () => {
    const owner = await provision('upload-retries@test.com'), projectId = await createProject(owner);
    const ticket = await createUpload(owner, projectId, { size: 3 });
    expect((await transfer(ticket, new Uint8Array([1]), env, 'text/plain')).status).toBe(415);
    expect((await transfer(ticket, new Uint8Array([1]))).status).toBe(400);
    const failing = { ...env, FILES: { put: async () => { throw new Error('Simulated R2 failure'); } } as unknown as R2Bucket };
    expect((await transfer(ticket, new Uint8Array([1, 2, 3]), failing)).status).toBe(500);
    const responses = await Promise.all([transfer(ticket, new Uint8Array([1, 2, 3])), transfer(ticket, new Uint8Array([4, 5, 6]))]);
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 404 || response.status === 409)).toHaveLength(1);
    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM attachments WHERE id = ?').bind(ticket.attachment_id).first<{ count: number }>();
    expect(count!.count).toBe(1);
    const oversized = await createUpload(owner, projectId);
    expect((await transfer(oversized, new Uint8Array(10 * 1024 * 1024 + 1))).status).toBe(413);
    expect((await transfer(oversized, new Uint8Array())).status).toBe(201);
  });
});

describe('MCP tools with real D1 and R2 bindings', () => {
  it('covers project, key, role and item workflows including filters, polling and version conflicts', async () => {
    const owner = await provision('mcp-owner@test.com');
    const headers = mcpBearer(owner);
    expect((await mcpTool('get_api_v1_me', {}, headers)).status).toBe(200);
    const created = await mcpTool('post_api_v1_projects', { body: { name: 'MCP project', instructions: 'Read first' } }, headers);
    expect(created.status).toBe(201);
    const projectId = created.body.data.id;
    expect((await mcpTool('get_api_v1_projects', { limit: 1 }, headers)).body.data[0].id).toBe(projectId);
    expect((await mcpTool('get_api_v1_projects_projectId', { projectId }, headers)).body.data.name).toBe('MCP project');
    expect((await mcpTool('patch_api_v1_projects_projectId', { projectId, body: { name: 'Updated' } }, headers)).body.data.name).toBe('Updated');
    expect((await mcpTool('get_api_v1_projects_projectId_llm', { projectId }, headers)).body.data.project.instructions).toBe('Read first');
    const key = await mcpTool('post_api_v1_projects_projectId_keys', { projectId, body: { name: 'MCP agent' } }, headers);
    expect(key.status).toBe(201);
    const agent = mcpBearer(key.body.data.api_key);
    const role = await mcpTool('createProjectRole', { projectId, body: { name: 'Developer' } }, headers);
    expect(role.status).toBe(201);
    const roleId = role.body.data.id;
    expect((await mcpTool('listProjectRoles', { projectId }, agent)).body.data[0].id).toBe(roleId);
    const item = await mcpTool('post_api_v1_projects_projectId_items', { projectId, body: {
      title: 'MCP task', kind: 'task', role_id: roleId, recipient_role_ids: [roleId], tags: ['API', 'MCP'],
    } }, agent);
    expect(item.status).toBe(201);
    const itemId = item.body.data.id;
    expect((await mcpTool('get_api_v1_projects_projectId_items_itemId', { projectId, itemId }, agent)).body.data.tags).toEqual(['api', 'mcp']);
    const filtered = await mcpTool('get_api_v1_projects_projectId_items', {
      projectId, tag: ['api', 'mcp'], recipient_role_id: roleId, kind: 'task', updated_since: '2020-01-01T00:00:00Z', include_deleted: true,
    }, agent);
    expect(filtered.body.data.map((row: any) => row.id)).toEqual([itemId]);
    expect(filtered.body.sync_until).toBeTruthy();
    const updated = await mcpTool('patch_api_v1_projects_projectId_items_itemId', { projectId, itemId, body: { version: 1, status: 'done' } }, agent);
    expect(updated.body.data.version).toBe(2);
    const stale = await mcpTool('delete_api_v1_projects_projectId_items_itemId', { projectId, itemId, body: { version: 1 } }, agent);
    expect(stale.status).toBe(409); expect(stale.isError).toBe(true);
    const deleted = await mcpTool('delete_api_v1_projects_projectId_items_itemId', { projectId, itemId, body: { version: 2 } }, agent);
    expect(deleted).toMatchObject({ status: 204, body: null, isError: false });
    const tombstones = await mcpTool('get_api_v1_projects_projectId_items', { projectId, include_deleted: true }, agent);
    expect(tombstones.body.data[0].deleted_at).toBeTruthy();
    expect((await mcpTool('updateProjectRole', { projectId, roleId, body: { archived: true } }, headers)).body.data.archived_at).toBeTruthy();
    const userKey = await mcpTool('post_api_v1_keys', { body: { name: 'Extra key' } }, headers);
    expect((await mcpTool('get_api_v1_keys', {}, headers)).body.data.map((row: any) => row.id)).toContain(userKey.body.data.id);
    expect((await mcpTool('delete_api_v1_keys_keyId', { keyId: userKey.body.data.id }, headers)).status).toBe(204);
  });

  it('round-trips binary attachments, including empty files and the REST 10 MiB limit', async () => {
    const owner = await provision('mcp-files@test.com'), projectId = await createProject(owner);
    const headers = mcpBearer((await projectKey(owner, projectId)).api_key);
    for (const encoded of ['AAEC/w==', '', Buffer.alloc(10 * 1024 * 1024, 255).toString('base64')]) {
      const upload = await mcpTool('post_api_v1_projects_projectId_attachments', {
        projectId, filename: '二进制.bin', content_base64: encoded, content_type: 'application/octet-stream',
      }, headers);
      expect(upload.status).toBe(201);
      const attachmentId = upload.body.data.id;
      const list = await mcpTool('get_api_v1_projects_projectId_attachments', { projectId }, headers);
      expect(list.body.data.map((row: any) => row.id)).toContain(attachmentId);
      const download = await mcpTool('get_api_v1_projects_projectId_attachments_attachmentId', { projectId, attachmentId }, headers);
      expect(download.status).toBe(200);
      expect(download.body.data.content_base64 === encoded).toBe(true);
      expect(download.body.data.content_disposition).toContain(encodeURIComponent('二进制.bin'));
      expect((await mcpTool('delete_api_v1_projects_projectId_attachments_attachmentId', { projectId, attachmentId }, headers)).status).toBe(204);
      expect((await mcpTool('get_api_v1_projects_projectId_attachments_attachmentId', { projectId, attachmentId }, headers)).status).toBe(404);
    }
  });

  it('preserves missing/revoked credentials, read-only keys, user/project isolation and archived projects', async () => {
    const owner = await provision('mcp-isolation@test.com'), stranger = await provision('mcp-stranger@test.com');
    const projectId = await createProject(owner), otherProject = await createProject(owner);
    const reader = await projectKey(owner, projectId, 'read'), writer = await projectKey(owner, projectId);
    for (const headers of [{}, mcpBearer('wrong')]) {
      const denied = await mcpTool('get_api_v1_projects_projectId', { projectId }, headers);
      expect(denied.status).toBe(401); expect(denied.isError).toBe(true);
      expect(denied.body.error.documentation).toBe('https://co-ai.test/llm');
    }
    const readOnly = await mcpTool('post_api_v1_projects_projectId_items', { projectId, body: { title: 'Denied' } }, mcpBearer(reader.api_key));
    expect(readOnly.status).toBe(403); expect(readOnly.body.error.documentation).toBe('https://co-ai.test/llm');
    expect((await mcpTool('get_api_v1_projects_projectId', { projectId }, mcpBearer(stranger))).status).toBe(404);
    expect((await mcpTool('get_api_v1_projects_projectId', { projectId: otherProject }, mcpBearer(writer.api_key))).status).toBe(404);
    expect((await mcpTool('createProjectRole', { projectId, body: { name: 'Escalation' } }, mcpBearer(writer.api_key))).status).toBe(403);
    await request(`/api/v1/keys/${writer.id}`, owner, 'DELETE');
    expect((await mcpTool('get_api_v1_projects_projectId', { projectId }, mcpBearer(writer.api_key))).status).toBe(401);
    await request(`/api/v1/projects/${projectId}`, owner, 'PATCH', { archived: true });
    expect((await mcpTool('get_api_v1_projects_projectId', { projectId }, mcpBearer(reader.api_key))).status).toBe(404);
  });

  it('covers administrator and Web account operations without bypassing session or CSRF requirements', async () => {
    const created = await mcpTool('post_api_admin_users', { body: { email: 'mcp-admin-user@test.com', name: 'Managed' } }, mcpBearer(admin));
    expect(created.status).toBe(201);
    const userId = created.body.data.user.id, key = created.body.data.key.api_key;
    expect((await mcpTool('get_api_admin_users', { limit: 100 }, mcpBearer(admin))).body.data.map((row: any) => row.id)).toContain(userId);
    const changed = await mcpTool('patch_api_admin_users_userId', { userId, body: { name: 'Renamed' } }, mcpBearer(admin));
    expect(changed.body.data.name).toBe('Renamed');
    expect((await mcpTool('get_api_admin_users', {}, mcpBearer(key))).status).toBe(401);
    const input = { body: { role: 'user', credential: key } };
    expect((await mcpTool('web_login', input, mcpBearer(key))).status).toBe(403);
    const loggedIn = await mcpTool('web_login', input, { ...mcpBearer(key), Origin: 'https://co-ai.test' });
    expect(loggedIn.status).toBe(200);
    const cookie = loggedIn.response.headers.get('Set-Cookie');
    expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('Secure');
    const sessionHeaders = { Cookie: cookie.split(';')[0], Origin: 'https://co-ai.test' };
    expect((await mcpTool('web_session', {}, sessionHeaders)).body.data.user.id).toBe(userId);
    expect((await mcpTool('get_api_v1_me', {}, sessionHeaders)).body.data.id).toBe(userId);
    expect((await mcpTool('web_set_credentials', { body: { username: 'mcp_login', password: 'mcp-password-12345' } }, sessionHeaders)).status).toBe(204);
    const reset = await mcpTool('web_reset_key', {}, sessionHeaders);
    expect(reset.status).toBe(201);
    const passwordLogin = await mcpTool('web_login', { body: { role: 'user', username: 'mcp_login', password: 'mcp-password-12345' } }, { ...mcpBearer(reset.body.data.api_key), Origin: 'https://co-ai.test' });
    const passwordCookie = passwordLogin.response.headers.get('Set-Cookie').split(';')[0];
    const logout = await mcpTool('web_logout', {}, { Cookie: passwordCookie, Origin: 'https://co-ai.test' });
    expect(logout.status).toBe(204);
    expect(logout.response.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect((await mcpTool('web_session', {}, { Cookie: passwordCookie, Origin: 'https://co-ai.test' })).status).toBe(401);
    expect((await mcpTool('post_api_admin_users_userId_reset_key', { userId }, mcpBearer(admin))).status).toBe(201);
  });
});

const oauthRedirect = 'http://127.0.0.1:32123/callback';
const oauthVerifier = 'test-pkce-verifier-with-at-least-43-characters-1234567890';
async function oauthForm(path: string, input: Record<string, string>) {
  return app.request('https://co-ai.test' + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(input).toString() }, env);
}
async function registerOAuth(name = 'Test OAuth client') {
  const response = await request('/oauth/register', undefined, 'POST', { client_name: name, redirect_uris: [oauthRedirect], token_endpoint_auth_method: 'none' });
  expect(response.status).toBe(201);
  return (await response.json() as any).client_id as string;
}
async function pkceChallenge(value: string) {
  return Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('base64url');
}
async function startOAuth(clientId: string, cookie: string, resource: string, scope = 'read', verifier = oauthVerifier) {
  const query = new URLSearchParams({ client_id: clientId, redirect_uri: oauthRedirect, response_type: 'code', code_challenge: await pkceChallenge(verifier), code_challenge_method: 'S256', state: 'client-state', resource, scope });
  const response = await web('/oauth/authorize?' + query.toString(), cookie);
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  const id = /data-request="([a-f0-9]{64})"/.exec(await response.text())![1];
  const details = await web('/oauth/requests/' + id, cookie);
  expect(details.status).toBe(200);
  return id;
}
async function approveOAuth(id: string, cookie: string, projectId?: string) {
  const response = await web('/oauth/consent', cookie, 'POST', { request_id: id, decision: 'approve', project_id: projectId ?? null });
  expect(response.status).toBe(200);
  const callback = new URL((await response.json() as any).data.redirect);
  expect(callback.searchParams.get('state')).toBe('client-state');
  expect(callback.searchParams.get('iss')).toBe('https://co-ai.test');
  return callback.searchParams.get('code')!;
}
async function oauthTokens(clientId: string, code: string, resource: string, verifier = oauthVerifier) {
  const response = await oauthForm('/oauth/token', { grant_type: 'authorization_code', client_id: clientId, redirect_uri: oauthRedirect, code, code_verifier: verifier, resource });
  expect(response.status).toBe(200);
  return await response.json() as any;
}

describe('OAuth authorization server and protected resources', () => {
  it('validates MCP credentials before initialization and SSE, including revocation and disabled accounts', async () => {
    const owner = await provision('mcp-handshake@test.com'), projectId = await createProject(owner);
    const key = await projectKey(owner, projectId, 'read');
    const connect = (token: string, method = 'POST') => app.request('https://co-ai.test/mcp', {
      method, headers: { ...mcpBearer(token), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: method === 'POST' ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'handshake-test', version: '1' } } }) : undefined,
    }, env);
    expect((await connect(key.api_key)).status).toBe(200);
    const sse = await connect(key.api_key, 'GET');
    expect(sse.status).toBe(200);
    await sse.body!.cancel();
    for (const token of ['invalid-key', 'coao_at_invalid', '']) {
      for (const method of ['GET', 'POST']) {
        const denied = await connect(token, method);
        expect(denied.status).toBe(401);
        expect(denied.headers.get('WWW-Authenticate')).toContain('oauth-protected-resource/mcp');
      }
    }
    await request(`/api/v1/keys/${key.id}`, owner, 'DELETE');
    expect((await connect(key.api_key)).status).toBe(401);
    const me = await (await request('/api/v1/me', owner)).json() as any;
    await request(`/api/admin/users/${me.data.id}`, admin, 'PATCH', { disabled: true });
    expect((await connect(owner)).status).toBe(401);
    expect((await request('/health')).status).toBe(200);
    expect((await request('/llm')).status).toBe(200);
  });

  it('discovers OAuth endpoints and challenges REST/MCP clients at HTTP level', async () => {
    const metadata = await (await request('/.well-known/oauth-authorization-server')).json() as any;
    expect(metadata.issuer).toBe('https://co-ai.test');
    expect(metadata.code_challenge_methods_supported).toEqual(['S256']);
    expect(metadata.token_endpoint_auth_methods_supported).toEqual(['none']);
    for (const [path, resource] of [['/mcp', '/mcp'], ['/api/v1', '/api/v1'], ['/api/admin', '/api/admin']]) {
      const protectedResource = await (await request('/.well-known/oauth-protected-resource' + path)).json() as any;
      expect(protectedResource.resource).toBe('https://co-ai.test' + resource);
      expect(protectedResource.authorization_servers).toEqual(['https://co-ai.test']);
    }
    const denied = await request('/api/v1/projects');
    expect(denied.status).toBe(401);
    expect(denied.headers.get('WWW-Authenticate')).toContain('resource_metadata="https://co-ai.test/.well-known/oauth-protected-resource/api/v1"');
    const tool = await mcpTool('get_api_v1_projects');
    expect(tool.response.status).toBe(401);
    expect(tool.response.headers.get('WWW-Authenticate')).toContain('oauth-protected-resource/mcp');
    for (const path of ['/oauth/register', '/oauth/token', '/oauth/revoke', '/.well-known/oauth-authorization-server']) {
      expect((await app.request('http://co-ai.test' + path, { method: 'POST' }, env)).status).toBe(426);
    }
  });

  it('grants project REST reads with PKCE, audience binding, explicit consent and one-time codes', async () => {
    const owner = await provision('oauth-reader@test.com'), projectId = await createProject(owner), other = await createProject(owner);
    const cookie = await login('user', owner), clientId = await registerOAuth();
    const resource = 'https://co-ai.test/api/v1';
    const id = await startOAuth(clientId, cookie, resource);
    expect((await web('/oauth/consent', cookie, 'POST', { request_id: id, decision: 'approve', project_id: projectId }, 'https://evil.test')).status).toBe(403);
    const otherCookie = await login('user', owner);
    expect((await web('/oauth/requests/' + id, otherCookie)).status).toBe(403);
    const code = await approveOAuth(id, cookie, projectId);
    expect((await web('/oauth/consent', cookie, 'POST', { request_id: id, decision: 'approve', project_id: projectId })).status).toBe(400);
    const bad = await oauthForm('/oauth/token', { grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: oauthRedirect, code_verifier: 'wrong-verifier-with-at-least-43-characters-123456789', resource });
    expect(bad.status).toBe(400); expect((await bad.json() as any).error).toBe('invalid_grant');
    const tokens = await oauthTokens(clientId, code, resource);
    expect(tokens.token_type).toBe('Bearer'); expect(tokens.expires_in).toBe(3600); expect(tokens.scope).toBe('read');
    expect((await request(`/api/v1/projects/${projectId}`, tokens.access_token)).status).toBe(200);
    expect((await request(`/api/v1/projects/${other}`, tokens.access_token)).status).toBe(404);
    const write = await request(`/api/v1/projects/${projectId}/items`, tokens.access_token, 'POST', { title: 'Denied' });
    expect(write.status).toBe(403); expect(write.headers.get('WWW-Authenticate')).toContain('scope="write"');
    expect((await request('/api/v1/keys', tokens.access_token)).status).toBe(403);
    expect((await mcpTool('get_health', {}, mcpBearer(tokens.access_token))).status).toBe(401);
    const replay = await oauthForm('/oauth/token', { grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: oauthRedirect, code_verifier: oauthVerifier, resource });
    expect(replay.status).toBe(400);
    expect((await request(`/api/v1/projects/${projectId}`, tokens.access_token)).status).toBe(401);
    const rows = await env.DB.prepare('SELECT token_hash FROM oauth_access_tokens').all<{ token_hash: string }>();
    expect(rows.results.some((row) => row.token_hash === tokens.access_token)).toBe(false);
  });

  it('uses MCP access tokens through the internal REST dispatcher without accepting them on public REST URLs', async () => {
    const owner = await provision('oauth-mcp@test.com'), projectId = await createProject(owner);
    const cookie = await login('user', owner), clientId = await registerOAuth('MCP OAuth'), resource = 'https://co-ai.test/mcp';
    const code = await approveOAuth(await startOAuth(clientId, cookie, resource, 'read write'), cookie, projectId);
    const tokens = await oauthTokens(clientId, code, resource);
    const headers = mcpBearer(tokens.access_token);
    const crossOrigin = await mcpTool('get_api_v1_projects_projectId', { projectId }, { ...headers, Origin: 'https://client.test' });
    expect(crossOrigin.status).toBe(200);
    expect(crossOrigin.response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const created = await mcpTool('post_api_v1_projects_projectId_items', { projectId, body: { title: 'OAuth task', kind: 'task' } }, headers);
    expect(created.status).toBe(201);
    expect((await mcpTool('get_api_v1_projects_projectId_items', { projectId }, headers)).body.data[0].title).toBe('OAuth task');
    expect((await request(`/api/v1/projects/${projectId}`, tokens.access_token)).status).toBe(401);
    const escalate = await mcpTool('createProjectRole', { projectId, body: { name: 'Escalation' } }, headers);
    expect(escalate.status).toBe(403); expect(escalate.response.status).toBe(403);
    expect(escalate.response.headers.get('WWW-Authenticate')).toContain('oauth-protected-resource/mcp');
    expect(escalate.response.headers.get('WWW-Authenticate')).toContain('scope="manage"');
    const expired = await env.DB.prepare('UPDATE oauth_access_tokens SET expires_at = ? WHERE token_hash = ?').bind('2000-01-01T00:00:00Z', await digest(tokens.access_token)).run();
    expect(expired.meta.changes).toBe(1);
    expect((await mcpTool('get_health', {}, headers)).status).toBe(401);
  });

  it('preserves OAuth challenges and authenticated tool results in POST SSE mode', async () => {
    const owner = await provision('oauth-sse@test.com'), projectId = await createProject(owner);
    const cookie = await login('user', owner), clientId = await registerOAuth('SSE OAuth'), resource = 'https://co-ai.test/mcp';
    const tokens = await oauthTokens(clientId, await approveOAuth(await startOAuth(clientId, cookie, resource), cookie, projectId), resource);
    const invoke = (name: string, args: Record<string, unknown>, token?: string) => app.request('https://co-ai.test/mcp', {
      method: 'POST', headers: {
        'Content-Type': 'application/json', Accept: 'text/event-stream, application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }),
    }, env);
    const denied = await invoke('get_api_v1_projects_projectId', { projectId });
    expect(denied.status).toBe(401);
    expect(denied.headers.get('WWW-Authenticate')).toContain('oauth-protected-resource/mcp');
    const read = await invoke('get_api_v1_projects_projectId', { projectId }, tokens.access_token);
    expect(read.headers.get('Content-Type')).toBe('text/event-stream');
    const event = (await read.text()).split('\n').find((line) => line.startsWith('data: '))!;
    expect(JSON.parse(event.slice(6)).result.structuredContent).toMatchObject({ status: 200, body: { data: { id: projectId } } });
    const write = await invoke('post_api_v1_projects_projectId_items', { projectId, body: { title: 'Denied SSE write' } }, tokens.access_token);
    expect(write.status).toBe(403);
    expect(write.headers.get('WWW-Authenticate')).toContain('scope="write"');
  });

  it('accepts ChatGPT all-scope MCP requests and grants only the consenting identity scopes', async () => {
    const owner = await provision('oauth-chatgpt@test.com'), cookie = await login('user', owner);
    const clientId = await registerOAuth('ChatGPT'), resource = 'https://co-ai.test/mcp';
    const allScopes = 'read write manage admin';
    const id = await startOAuth(clientId, cookie, resource, allScopes);
    const details = await (await web('/oauth/requests/' + id, cookie)).json() as any;
    expect(details.data.scope).toBe('read write manage');
    const tokens = await oauthTokens(clientId, await approveOAuth(id, cookie), resource);
    expect(tokens.scope).toBe('read write manage');
    expect((await mcpTool('get_api_v1_projects', {}, mcpBearer(tokens.access_token))).status).toBe(200);
    expect((await mcpTool('get_api_admin_users', {}, mcpBearer(tokens.access_token))).status).toBe(403);
    const refreshed = await oauthForm('/oauth/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token, resource, scope: allScopes });
    expect(refreshed.status).toBe(400);
    expect((await refreshed.json() as any).error).toBe('invalid_scope');
    const adminCookie = await login('admin', admin);
    const adminId = await startOAuth(clientId, adminCookie, resource, allScopes);
    const adminDetails = await (await web('/oauth/requests/' + adminId, adminCookie)).json() as any;
    expect(adminDetails.data.scope).toBe('admin');
    const adminTokens = await oauthTokens(clientId, await approveOAuth(adminId, adminCookie), resource);
    expect(adminTokens.scope).toBe('admin');
    expect((await mcpTool('get_api_admin_users', {}, mcpBearer(adminTokens.access_token))).status).toBe(200);
    expect((await mcpTool('get_api_v1_projects', {}, mcpBearer(adminTokens.access_token))).status).toBe(403);
    for (const restResource of ['https://co-ai.test/api/v1', 'https://co-ai.test/api/admin']) {
      const query = new URLSearchParams({ client_id: clientId, redirect_uri: oauthRedirect, response_type: 'code', code_challenge: await pkceChallenge(oauthVerifier), code_challenge_method: 'S256', resource: restResource, scope: allScopes });
      expect((await web('/oauth/authorize?' + query, cookie)).status).toBe(400);
    }
  });

  it('rotates refresh tokens atomically, detects replay and revokes the whole grant', async () => {
    const owner = await provision('oauth-refresh@test.com'), projectId = await createProject(owner), cookie = await login('user', owner);
    const clientId = await registerOAuth('Refresh'), resource = 'https://co-ai.test/api/v1';
    const initial = await oauthTokens(clientId, await approveOAuth(await startOAuth(clientId, cookie, resource), cookie, projectId), resource);
    const input = { grant_type: 'refresh_token', client_id: clientId, refresh_token: initial.refresh_token, resource };
    const wrongResource = await oauthForm('/oauth/token', { ...input, resource: 'https://co-ai.test/mcp' });
    expect(wrongResource.status).toBe(400);
    const response = await oauthForm('/oauth/token', input);
    expect(response.status).toBe(200);
    const refreshed = await response.json() as any;
    expect(refreshed.refresh_token).not.toBe(initial.refresh_token);
    expect((await request(`/api/v1/projects/${projectId}`, refreshed.access_token)).status).toBe(200);
    expect((await oauthForm('/oauth/token', input)).status).toBe(400);
    expect((await request(`/api/v1/projects/${projectId}`, refreshed.access_token)).status).toBe(401);
    expect((await oauthForm('/oauth/token', { ...input, refresh_token: refreshed.refresh_token })).status).toBe(400);
  });

  it('supports management and administrator grants, revocation, key revocation and user disablement', async () => {
    const owner = await provision('oauth-management@test.com'), cookie = await login('user', owner), clientId = await registerOAuth('Management');
    const resource = 'https://co-ai.test/api/v1';
    const tokens = await oauthTokens(clientId, await approveOAuth(await startOAuth(clientId, cookie, resource, 'manage'), cookie), resource);
    const created = await request('/api/v1/projects', tokens.access_token, 'POST', { name: 'OAuth created' });
    expect(created.status).toBe(201);
    const keys = await (await request('/api/v1/keys', tokens.access_token)).json() as any;
    const actor = keys.data.find((key: any) => key.name === 'OAuth: Management');
    expect(actor).toBeTruthy();
    expect((await request(`/api/v1/keys/${actor.id}`, owner, 'DELETE')).status).toBe(204);
    expect((await request('/api/v1/projects', tokens.access_token)).status).toBe(401);
    const adminCookie = await login('admin', admin), adminResource = 'https://co-ai.test/api/admin';
    const adminTokens = await oauthTokens(clientId, await approveOAuth(await startOAuth(clientId, adminCookie, adminResource, 'admin'), adminCookie), adminResource);
    expect((await request('/api/admin/users', adminTokens.access_token)).status).toBe(200);
    expect((await request('/api/v1/projects', adminTokens.access_token)).status).toBe(401);
    const revoked = await oauthForm('/oauth/revoke', { client_id: clientId, token: adminTokens.refresh_token });
    expect(revoked.status).toBe(200);
    expect((await request('/api/admin/users', adminTokens.access_token)).status).toBe(401);
    expect((await oauthForm('/oauth/revoke', { client_id: clientId, token: 'unknown' })).status).toBe(200);
    const user = await (await request('/api/v1/me', owner)).json() as any;
    const next = await oauthTokens(clientId, await approveOAuth(await startOAuth(clientId, cookie, resource, 'manage'), cookie), resource);
    await request(`/api/admin/users/${user.data.id}`, admin, 'PATCH', { disabled: true });
    expect((await request('/api/v1/projects', next.access_token)).status).toBe(401);
  });

  it('rejects unsafe clients, unregistered redirects, unsupported flows, foreign resources, denied or expired requests and project escalation', async () => {
    const invalidClient = await request('/oauth/register', undefined, 'POST', { redirect_uris: ['http://evil.test/callback'] });
    expect(invalidClient.status).toBe(400); expect((await invalidClient.json() as any).error).toBe('invalid_redirect_uri');
    const clientId = await registerOAuth('Validation'), owner = await provision('oauth-validation@test.com'), cookie = await login('user', owner);
    const resource = 'https://co-ai.test/api/v1';
    const base = { client_id: clientId, redirect_uri: oauthRedirect, response_type: 'code', code_challenge: await pkceChallenge(oauthVerifier), code_challenge_method: 'S256', resource, scope: 'read' };
    for (const override of [{ redirect_uri: 'https://evil.test/callback' }, { response_type: 'token' }, { code_challenge_method: 'plain' }, { resource: 'https://evil.test/mcp' }, { scope: 'unknown' }, { scope: 'admin' }]) {
      const denied = await request('/oauth/authorize?' + new URLSearchParams({ ...base, ...override }));
      expect(denied.status).toBe(400); expect(denied.headers.get('Location')).toBeNull();
    }
    expect((await request('/oauth/authorize?' + new URLSearchParams(base) + '&client_id=' + clientId)).status).toBe(400);
    const another = await provision('oauth-other@test.com'), otherProject = await createProject(another);
    const id = await startOAuth(clientId, cookie, resource);
    expect((await web('/oauth/consent', cookie, 'POST', { request_id: id, decision: 'approve', project_id: otherProject })).status).toBe(403);
    const denial = await web('/oauth/consent', cookie, 'POST', { request_id: id, decision: 'deny' });
    expect(denial.status).toBe(200); expect(new URL((await denial.json() as any).data.redirect).searchParams.get('error')).toBe('access_denied');
    const expired = await startOAuth(clientId, cookie, resource);
    await env.DB.prepare('UPDATE oauth_requests SET expires_at = ? WHERE id = ?').bind('2000-01-01T00:00:00Z', expired).run();
    expect((await web('/oauth/requests/' + expired, cookie)).status).toBe(400);
    const options = await app.request('https://co-ai.test/oauth/token', { method: 'OPTIONS', headers: { Origin: 'https://client.test' } }, env);
    expect(options.status).toBe(204); expect(options.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});

it('completes discovery, dynamic registration, PKCE and OAuth-authenticated MCP calls with the official SDK', async () => {
  const owner = await provision('oauth-sdk@test.com'), projectId = await createProject(owner), cookie = await login('user', owner);
  let information: OAuthClientInformationMixed | undefined, tokens: OAuthTokens | undefined, verifier = '', authorizationUrl: URL | undefined;
  const provider: OAuthClientProvider = {
    redirectUrl: oauthRedirect,
    clientMetadata: { client_name: 'Official SDK OAuth', redirect_uris: [oauthRedirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] },
    state: () => 'sdk-state', clientInformation: () => information,
    saveClientInformation: (value) => { information = value; }, tokens: () => tokens,
    saveTokens: (value) => { tokens = value; }, saveCodeVerifier: (value) => { verifier = value; }, codeVerifier: () => verifier,
    redirectToAuthorization: (url) => { authorizationUrl = url; },
  };
  const fetchFn = async (url: string | URL, init?: RequestInit) => app.request(String(url), init, env);
  const client = new Client({ name: 'oauth-sdk-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL('https://co-ai.test/mcp'), { authProvider: provider, fetch: fetchFn });
  try {
    await expect(client.connect(transport)).rejects.toThrow(UnauthorizedError);
    expect(authorizationUrl!.searchParams.get('resource')).toBe('https://co-ai.test/mcp');
    expect(authorizationUrl!.searchParams.get('scope')).toBe('read');
    const page = await app.request(authorizationUrl!.href, { headers: { Cookie: cookie } }, env);
    expect(page.status).toBe(200);
    const id = /data-request="([a-f0-9]{64})"/.exec(await page.text())![1];
    expect((await web('/oauth/requests/' + id, cookie)).status).toBe(200);
    const consent = await web('/oauth/consent', cookie, 'POST', { request_id: id, decision: 'approve', project_id: projectId });
    const redirect = new URL((await consent.json() as any).data.redirect);
    expect(redirect.searchParams.get('state')).toBe('sdk-state');
    await transport.finishAuth(redirect.searchParams.get('code')!);
    await client.close();
    await client.connect(new StreamableHTTPClientTransport(new URL('https://co-ai.test/mcp'), { authProvider: provider, fetch: fetchFn }));
    const result = await client.callTool({ name: 'get_api_v1_projects_projectId', arguments: { projectId } });
    expect(result.structuredContent).toMatchObject({ status: 200, body: { data: { id: projectId } } });
  } finally { await client.close(); }
});

it('prevents concurrent refresh from keeping a live authorization and invalidates grants after password/admin credential changes', async () => {
  const owner = await provision('oauth-replay-race@test.com'), cookie = await login('user', owner), projectId = await createProject(owner);
  const clientId = await registerOAuth('Race and credentials'), resource = 'https://co-ai.test/api/v1';
  const initial = await oauthTokens(clientId, await approveOAuth(await startOAuth(clientId, cookie, resource), cookie, projectId), resource);
  const input = { grant_type: 'refresh_token', client_id: clientId, refresh_token: initial.refresh_token, resource };
  const responses = await Promise.all([oauthForm('/oauth/token', input), oauthForm('/oauth/token', input)]);
  expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
  const success = await responses.find((response) => response.status === 200)!.json() as any;
  expect((await request(`/api/v1/projects/${projectId}`, success.access_token)).status).toBe(401);
  const passwordGrant = await oauthTokens(clientId, await approveOAuth(await startOAuth(clientId, cookie, resource), cookie, projectId), resource);
  expect((await web('/api/web/credentials', cookie, 'PUT', { username: 'oauth_password_change', password: 'oauth-new-password-12345' })).status).toBe(204);
  expect((await request(`/api/v1/projects/${projectId}`, passwordGrant.access_token)).status).toBe(401);
  expect((await oauthForm('/oauth/token', { ...input, refresh_token: passwordGrant.refresh_token })).status).toBe(400);
  const adminCookie = await login('admin', admin), adminResource = 'https://co-ai.test/api/admin';
  const adminGrant = await oauthTokens(clientId, await approveOAuth(await startOAuth(clientId, adminCookie, adminResource, 'admin'), adminCookie), adminResource);
  const rotatedEnv = { ...env, ADMIN_TOKEN: 'a-new-administrator-secret-with-32-characters' };
  const denied = await app.request('https://co-ai.test/api/admin/users', { headers: { Authorization: 'Bearer ' + adminGrant.access_token } }, rotatedEnv);
  expect(denied.status).toBe(401);
});

const testColumns = [
  { name: 'title', type: 'text', required: true },
  { name: 'count', type: 'integer' },
  { name: 'amount', type: 'real' },
  { name: 'active', type: 'boolean' },
  { name: 'extra', type: 'json' },
];
async function createDataTable(key: string, project: string, name = 'Records') {
  const response = await request(`/api/v1/projects/${project}/tables`, key, 'POST', { name, columns: testColumns });
  expect(response.status).toBe(201);
  return (await response.json() as any).data;
}
describe('Project D1 data tables', () => {
  it('creates multiple physical typed tables and reads, filters, updates and deletes versioned records', async () => {
    const owner = await provision('tables-crud@test.com'), project = await createProject(owner);
    const table = await createDataTable(owner, project), other = await createDataTable(owner, project, 'Other');
    const base = `/api/v1/projects/${project}/tables`, rows = `${base}/${table.id}/rows`;
    expect((await (await request(base, owner)).json() as any).data).toHaveLength(2);
    const discovery = await (await request(`/api/v1/projects/${project}/llm`, owner)).json() as any;
    expect(discovery.data.endpoints.tables).toBe('https://co-ai.test' + base);
    const physical = 'project_data_' + table.id.replaceAll('-', '');
    expect(await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").bind(physical).first()).toBeTruthy();
    const values = { title: "O'Reilly %_ 客户", count: 5, amount: 12.5, active: false, extra: { nested: [true, null, '内容'] } };
    const created = await request(rows, owner, 'POST', { values });
    expect(created.status).toBe(201);
    const row = (await created.json() as any).data;
    expect(row.values).toEqual(values); expect(row.version).toBe(1);
    const minimal = await request(rows, owner, 'POST', { values: { title: 'Second' } });
    expect(minimal.status).toBe(201);
    expect((await minimal.json() as any).data.values).toEqual({ title: 'Second', count: null, amount: null, active: null, extra: null });
    expect((await (await request(`${base}/${other.id}/rows`, owner)).json() as any).data).toEqual([]);
    const filter = encodeURIComponent(JSON.stringify([{ column: 'amount', op: 'gte', value: 10 }, { column: 'title', op: 'contains', value: '%_' }, { column: 'active', op: 'eq', value: false }]));
    expect((await (await request(rows + '?filters=' + filter, owner)).json() as any).data.map((record: any) => record.id)).toEqual([row.id]);
    const nullFilter = encodeURIComponent(JSON.stringify([{ column: 'count', op: 'is_null' }]));
    expect((await (await request(rows + '?filters=' + nullFilter, owner)).json() as any).data).toHaveLength(1);
    const firstPage = await (await request(rows + '?limit=1', owner)).json() as any;
    expect(firstPage.data).toHaveLength(1); expect(firstPage.next_cursor).toBeTruthy();
    const secondPage = await (await request(rows + '?limit=1&after=' + firstPage.next_cursor, owner)).json() as any;
    expect(secondPage.data).toHaveLength(1); expect(secondPage.next_cursor).toBeNull();
    expect(secondPage.data[0].id).not.toBe(firstPage.data[0].id);
    const changed = await request(rows + '/' + row.id, owner, 'PATCH', { version: 1, values: { active: true, count: 6 } });
    expect(changed.status).toBe(200);
    const next = (await changed.json() as any).data;
    expect(next.version).toBe(2); expect(next.values).toEqual({ ...values, active: true, count: 6 });
    expect((await request(rows + '/' + row.id, owner, 'PATCH', { version: 1, values: { count: 7 } })).status).toBe(409);
    expect((await request(rows + '/' + row.id, owner, 'DELETE', { version: 1 })).status).toBe(409);
    expect((await request(rows + '/' + row.id, owner, 'DELETE', { version: 2 })).status).toBe(204);
    expect((await request(rows + '/' + row.id, owner)).status).toBe(404);
    expect((await request(rows + '/' + row.id, owner, 'PATCH', { version: 2, values: { count: 7 } })).status).toBe(404);
    expect((await request(`${base}/${table.id}`, owner, 'PATCH', { name: 'Renamed', description: 'New description' })).status).toBe(200);
    await request(`${base}/${table.id}`, owner, 'PATCH', { name: 'Again' });
    expect((await (await request(`${base}/${table.id}`, owner)).json() as any).data.description).toBe('New description');
    expect((await request(`${base}/${table.id}`, owner, 'DELETE')).status).toBe(204);
    expect(await env.DB.prepare('SELECT name FROM sqlite_master WHERE name = ?').bind(physical).first()).toBeNull();
    expect((await request(`${base}/${table.id}`, owner)).status).toBe(404);
    expect((await request(`${base}/${other.id}`, owner)).status).toBe(200);
  });

  it('rejects invalid schemas and values, arbitrary identifiers, SQL injection and name collisions', async () => {
    const owner = await provision('tables-validation@test.com'), project = await createProject(owner);
    const base = `/api/v1/projects/${project}/tables`, table = await createDataTable(owner, project), rows = `${base}/${table.id}/rows`;
    for (const columns of [[], [{ name: '_id', type: 'text' }], [{ name: 'x"; DROP TABLE users;--', type: 'text' }], [{ name: 'name', type: 'mysql' }], [{ name: 'X', type: 'text' }, { name: 'x', type: 'integer' }], Array.from({ length: 33 }, (_, i) => ({ name: 'c' + i, type: 'text' }))]) {
      expect((await request(base, owner, 'POST', { name: 'Invalid', columns })).status).toBe(400);
    }
    expect((await request(base, owner, 'POST', { name: 'records', columns: testColumns })).status).toBe(409);
    const other = await createDataTable(owner, project, 'Other');
    expect((await request(`${base}/${other.id}`, owner, 'PATCH', { name: 'RECORDS' })).status).toBe(409);
    const concurrent = await Promise.all([request(base, owner, 'POST', { name: 'Concurrent', columns: testColumns }), request(base, owner, 'POST', { name: 'Concurrent', columns: testColumns })]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([201, 409]);

    expect((await request(`${base}/${table.id}`, owner, 'PATCH', { columns: testColumns })).status).toBe(400);
    for (const values of [{}, { title: null }, { title: 3 }, { title: 'ok', count: 1.1 }, { title: 'ok', count: Number.MAX_SAFE_INTEGER + 1 }, { title: 'ok', active: 1 }, { title: 'ok', unknown: 'x' }, { title: 'x'.repeat(20001) }, { title: 'ok', extra: 'x'.repeat(20001) }]) {
      expect((await request(rows, owner, 'POST', { values })).status).toBe(400);
    }
    for (const filters of ['no-json', '{}', JSON.stringify([{ column: 'unknown', op: 'eq', value: 1 }]), JSON.stringify([{ column: 'count', op: 'contains', value: 1 }]), JSON.stringify([{ column: 'title', op: 'eq' }]), JSON.stringify([{ column: 'title', op: 'eq); DROP TABLE users;--', value: 'x' }])]) {
      expect((await request(rows + '?filters=' + encodeURIComponent(filters), owner)).status).toBe(400);
    }
    expect((await request(base + '/users/rows', owner)).status).toBe(404);
    expect((await request(base + '/' + encodeURIComponent('x"; DROP TABLE users;--') + '/rows', owner)).status).toBe(404);
    expect((await request('/api/v1/me', owner)).status).toBe(200);
    const created = await request(rows, owner, 'POST', { values: { title: "'; DROP TABLE users;--" } });
    expect(created.status).toBe(201);
    const row = (await created.json() as any).data;
    expect((await request(rows + '/' + row.id, owner, 'PATCH', { version: 1, values: {} })).status).toBe(400);
    expect((await request(rows + '/' + row.id, owner, 'DELETE', { version: 0 })).status).toBe(400);
    expect((await request('/api/v1/me', owner)).status).toBe(200);
  });

  it('isolates projects and users and preserves read-only, schema management and archived-project boundaries', async () => {
    const owner = await provision('tables-owner@test.com'), foreign = await provision('tables-foreign@test.com');
    const project = await createProject(owner), second = await createProject(owner), foreignProject = await createProject(foreign);
    const table = await createDataTable(owner, project), writer = (await projectKey(owner, project)).api_key, reader = (await projectKey(owner, project, 'read')).api_key;
    const base = `/api/v1/projects/${project}/tables`, rows = `${base}/${table.id}/rows`;
    expect((await request(base, writer, 'POST', { name: 'Forbidden', columns: testColumns })).status).toBe(403);
    expect((await request(`${base}/${table.id}`, writer, 'PATCH', { name: 'Forbidden' })).status).toBe(403);
    expect((await request(`${base}/${table.id}`, writer, 'DELETE')).status).toBe(403);
    expect((await request(rows, reader, 'POST', { values: { title: 'No' } })).status).toBe(403);
    const row = (await (await request(rows, writer, 'POST', { values: { title: 'Visible' } })).json() as any).data;
    expect((await request(rows, reader)).status).toBe(200);
    expect((await request(rows + '/' + row.id, reader, 'PATCH', { version: 1, values: { title: 'No' } })).status).toBe(403);
    expect((await request(rows + '/' + row.id, reader, 'DELETE', { version: 1 })).status).toBe(403);
    expect((await request(rows, foreign)).status).toBe(404);
    expect((await request(`/api/v1/projects/${second}/tables/${table.id}/rows`, owner)).status).toBe(404);
    expect((await request(`/api/v1/projects/${foreignProject}/tables/${table.id}/rows`, foreign)).status).toBe(404);
    expect((await request(`/api/v1/projects/${second}/tables`, writer)).status).toBe(404);
    await request(`/api/v1/projects/${project}`, owner, 'PATCH', { archived: true });
    expect((await request(rows, writer)).status).toBe(404);
    expect((await request(rows, owner)).status).toBe(200);
    await request(`/api/v1/projects/${project}`, owner, 'PATCH', { archived: false });
    expect((await request(rows, writer)).status).toBe(200);
  });

  it('exposes table and row workflows through MCP with OAuth read, write and manage scopes', async () => {
    const owner = await provision('tables-mcp@test.com'), projectId = await createProject(owner), cookie = await login('user', owner), clientId = await registerOAuth('Tables');
    const resource = 'https://co-ai.test/mcp';
    const management = await oauthTokens(clientId, await approveOAuth(await startOAuth(clientId, cookie, resource, 'manage'), cookie), resource);
    const created = await mcpTool('createProjectTable', { projectId, body: { name: 'MCP table', columns: testColumns } }, mcpBearer(management.access_token));
    expect(created.status).toBe(201);
    const tableId = created.body.data.id;
    const tokens = await oauthTokens(clientId, await approveOAuth(await startOAuth(clientId, cookie, resource, 'write'), cookie, projectId), resource);
    const headers = mcpBearer(tokens.access_token);
    expect((await mcpTool('getProjectTable', { projectId, tableId }, headers)).status).toBe(200);
    const row = await mcpTool('createTableRow', { projectId, tableId, body: { values: { title: 'AI record', count: 2 } } }, headers);
    expect(row.status).toBe(201);
    const rowId = row.body.data.id;
    expect((await mcpTool('listTableRows', { projectId, tableId, filters: JSON.stringify([{ column: 'count', op: 'eq', value: 2 }]) }, headers)).body.data).toHaveLength(1);
    expect((await mcpTool('updateTableRow', { projectId, tableId, rowId, body: { version: 1, values: { count: 3 } } }, headers)).status).toBe(200);
    expect((await mcpTool('getTableRow', { projectId, tableId, rowId }, headers)).body.data.values.count).toBe(3);
    const denied = await mcpTool('deleteProjectTable', { projectId, tableId }, headers);
    expect(denied.status).toBe(403); expect(denied.response.headers.get('WWW-Authenticate')).toContain('scope="manage"');
    const readTokens = await oauthTokens(clientId, await approveOAuth(await startOAuth(clientId, cookie, resource), cookie, projectId), resource);
    expect((await mcpTool('listTableRows', { projectId, tableId }, mcpBearer(readTokens.access_token))).status).toBe(200);
    expect((await mcpTool('deleteTableRow', { projectId, tableId, rowId, body: { version: 2 } }, mcpBearer(readTokens.access_token))).status).toBe(403);
    expect((await mcpTool('deleteTableRow', { projectId, tableId, rowId, body: { version: 2 } }, headers)).status).toBe(204);
    expect((await mcpTool('updateProjectTable', { projectId, tableId, body: { description: 'Updated' } }, mcpBearer(management.access_token))).status).toBe(200);
    expect((await mcpTool('deleteProjectTable', { projectId, tableId }, mcpBearer(management.access_token))).status).toBe(204);
  });
});

async function eventRpc(key: string, method: string, params: Record<string, unknown> = {}) {
  const response = await app.request('https://co-ai.test/mcp', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }, env);
  return { response, body: await response.json() as any };
}
const signingSecret = 'whsec_' + btoa('12345678901234567890123456789012');

describe('MCP role message events', () => {
  it('discovers MCP 2.0 events and tools, verifies subscriptions and enforces project boundaries', async () => {
    const owner = await provision('events-boundaries@test.com'), projectId = await createProject(owner);
    const role = await createRole(owner, projectId, 'Receiver'), otherProject = await createProject(owner);
    const reader = (await projectKey(owner, projectId, 'read')).api_key;
    const discover = await eventRpc(reader, 'server/discover');
    expect(discover.body.result).toMatchObject({ resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { events: {} } });
    expect((await eventRpc(reader, 'events/list')).body.result.events[0].name).toBe('role.messages.received');
    expect((await eventRpc(reader, 'tools/list')).body.result.tools.length).toBeGreaterThan(0);
    expect((await eventRpc(reader, 'tools/call', { name: 'listProjectRoles', arguments: { projectId } })).body.result.structuredContent.body.data[0].id).toBe(role.id);
    const params = { name: 'role.messages.received', arguments: { project_id: projectId, recipient_role_id: role.id }, delivery: { mode: 'webhook', url: 'https://receiver.example/events-boundaries', secret: signingSecret } };
    vi.mocked(webhookPost).mockClear();
    const subscribed = (await eventRpc(reader, 'events/subscribe', params)).body.result;
    expect(subscribed.id).toMatch(/^sub_/);
    expect(vi.mocked(webhookPost)).toHaveBeenCalledTimes(1);
    const verification = vi.mocked(webhookPost).mock.calls[0];
    expect(JSON.parse(verification[1]).type).toBe('verification');
    expect(verification[2]['X-MCP-Subscription-Id']).toBe(subscribed.id);
    expect(verification[2]['webhook-signature']).toMatch(/^v1,/);
    const refreshed = await eventRpc(reader, 'events/subscribe', { ...params, arguments: { recipient_role_id: role.id, project_id: projectId }, ttlMs: 120_000 });
    expect(refreshed.body.result.id).toBe(subscribed.id);
    expect(Date.parse(refreshed.body.result.refreshBefore) - Date.now()).toBeLessThanOrEqual(120_000);
    expect(vi.mocked(webhookPost)).toHaveBeenCalledTimes(1);
    expect((await eventRpc(reader, 'events/subscribe', { ...params, arguments: { project_id: otherProject, recipient_role_id: role.id } })).body.error.code).toBe(-32024);
    expect((await eventRpc(reader, 'events/subscribe', { ...params, delivery: { ...params.delivery, url: 'http://localhost/events' } })).body.error.code).toBe(-32602);
    expect((await eventRpc(reader, 'events/subscribe', { ...params, delivery: { ...params.delivery, secret: 'whsec_YQ==' } })).body.error.code).toBe(-32602);
    const unsubscribe = { ...params, delivery: { mode: 'webhook', url: params.delivery.url } };
    expect((await eventRpc(owner, 'events/unsubscribe', unsubscribe)).body.result.resultType).toBe('complete');
    expect(await env.DB.prepare('SELECT id FROM mcp_event_subscriptions WHERE id = ?').bind(subscribed.id).first()).not.toBeNull();
    for (let i = 0; i < 2; i++) expect((await eventRpc(reader, 'events/unsubscribe', unsubscribe)).body.result.resultType).toBe('complete');
    expect(await env.DB.prepare('SELECT id FROM mcp_event_subscriptions WHERE id = ?').bind(subscribed.id).first()).toBeNull();
  });

  it('coalesces matching messages, honors cooldown, preserves retries and stops after revocation', async () => {
    const owner = await provision('events-delivery@test.com'), projectId = await createProject(owner);
    const role = await createRole(owner, projectId, 'Receiver'), sender = await createRole(owner, projectId, 'Sender');
    const key = await projectKey(owner, projectId);
    const params = { name: 'role.messages.received', arguments: { project_id: projectId, recipient_role_id: role.id }, delivery: { mode: 'webhook', url: 'https://receiver.example/events-delivery', secret: signingSecret } };
    const id = (await eventRpc(key.api_key, 'events/subscribe', params)).body.result.id;
    const base = `/api/v1/projects/${projectId}/items`;
    for (const input of [
      { title: 'Note', kind: 'note' }, { title: 'Other recipient', kind: 'message', recipient_role_ids: [sender.id] },
      { title: 'Self broadcast', kind: 'message', role_id: role.id },
      { title: 'Direct', kind: 'message', recipient_role_ids: [role.id], role_id: sender.id },
      { title: 'Broadcast', kind: 'message', recipient_role_ids: ['ALL'], role_id: sender.id },
    ]) expect((await request(base, owner, 'POST', input)).status).toBe(201);
    expect((await env.DB.prepare('SELECT pending_count FROM mcp_event_subscriptions WHERE id = ?').bind(id).first<any>()).pending_count).toBe(2);
    vi.mocked(webhookPost).mockClear();
    await deliverMessageEvents(env);
    expect(vi.mocked(webhookPost)).not.toHaveBeenCalled();
    await env.DB.prepare('UPDATE mcp_event_subscriptions SET next_attempt = 0 WHERE id = ?').bind(id).run();
    vi.mocked(webhookPost).mockResolvedValueOnce({ status: 503, body: '' });
    await Promise.all([deliverMessageEvents(env), deliverMessageEvents(env)]);
    expect(vi.mocked(webhookPost)).toHaveBeenCalledTimes(1);
    const failedBody = vi.mocked(webhookPost).mock.calls[0][1];
    expect(JSON.parse(failedBody)).toMatchObject({ name: 'role.messages.received', cursor: null, data: { message_count: 2, recipient_role_id: role.id } });
    await request(base, owner, 'POST', { title: 'During retry', kind: 'message' });
    await deliverMessageEvents(env);
    expect(vi.mocked(webhookPost)).toHaveBeenCalledTimes(1);
    await env.DB.prepare('UPDATE mcp_event_subscriptions SET next_attempt = 0 WHERE id = ?').bind(id).run();
    await deliverMessageEvents(env);
    expect(vi.mocked(webhookPost).mock.calls[1][1]).toBe(failedBody);
    const pending = await env.DB.prepare('SELECT pending_count, event_body, next_attempt FROM mcp_event_subscriptions WHERE id = ?').bind(id).first<any>();
    expect(pending).toMatchObject({ pending_count: 1, event_body: null });
    expect(pending.next_attempt - Date.now()).toBeGreaterThan(290_000);
    await request(`/api/v1/keys/${key.id}`, owner, 'DELETE');
    await env.DB.prepare('UPDATE mcp_event_subscriptions SET next_attempt = 0 WHERE id = ?').bind(id).run();
    await deliverMessageEvents(env);
    expect(vi.mocked(webhookPost)).toHaveBeenCalledTimes(2);
    expect(await env.DB.prepare('SELECT id FROM mcp_event_subscriptions WHERE id = ?').bind(id).first()).toBeNull();
  });

  it('stops OAuth delivery after grant revocation and bounds transient and permanent failures', async () => {
    const owner = await provision('events-oauth@test.com'), projectId = await createProject(owner), role = await createRole(owner, projectId, 'Receiver');
    const cookie = await login('user', owner), clientId = await registerOAuth('Events'), resource = 'https://co-ai.test/mcp';
    const tokens = await oauthTokens(clientId, await approveOAuth(await startOAuth(clientId, cookie, resource, 'read'), cookie, projectId), resource);
    const params = { name: 'role.messages.received', arguments: { project_id: projectId, recipient_role_id: role.id }, delivery: { mode: 'webhook', url: 'https://receiver.example/events-oauth', secret: signingSecret } };
    const id = (await eventRpc(tokens.access_token, 'events/subscribe', params)).body.result.id;
    await request(`/api/v1/projects/${projectId}/items`, owner, 'POST', { title: 'Incoming', kind: 'message' });
    await oauthForm('/oauth/revoke', { client_id: clientId, token: tokens.access_token });
    vi.mocked(webhookPost).mockClear();
    await env.DB.prepare('UPDATE mcp_event_subscriptions SET next_attempt = 0 WHERE id = ?').bind(id).run();
    await deliverMessageEvents(env);
    expect(webhookPost).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT id FROM mcp_event_subscriptions WHERE id = ?').bind(id).first()).toBeNull();

    const activeId = (await eventRpc(owner, 'events/subscribe', params)).body.result.id;
    await request(`/api/v1/projects/${projectId}/items`, owner, 'POST', { title: 'Retry', kind: 'message' });
    vi.mocked(webhookPost).mockClear();
    for (let attempt = 0; attempt < 4; attempt++) {
      await env.DB.prepare('UPDATE mcp_event_subscriptions SET next_attempt = 0 WHERE id = ?').bind(activeId).run();
      vi.mocked(webhookPost).mockResolvedValueOnce({ status: 500, body: '' });
      await deliverMessageEvents(env);
    }
    expect(webhookPost).toHaveBeenCalledTimes(4);
    expect(new Set(vi.mocked(webhookPost).mock.calls.map((call) => JSON.parse(call[1]).eventId)).size).toBe(1);
    expect((await env.DB.prepare('SELECT event_body, pending_count FROM mcp_event_subscriptions WHERE id = ?').bind(activeId).first<any>())).toMatchObject({ event_body: null, pending_count: 0 });
    for (const status of [413, 410]) {
      await request(`/api/v1/projects/${projectId}/items`, owner, 'POST', { title: 'Permanent failure', kind: 'message' });
      await env.DB.prepare('UPDATE mcp_event_subscriptions SET next_attempt = 0 WHERE id = ?').bind(activeId).run();
      vi.mocked(webhookPost).mockResolvedValueOnce({ status, body: '' });
      await deliverMessageEvents(env);
      await deliverMessageEvents(env);
    }
    expect(webhookPost).toHaveBeenCalledTimes(6);
    expect(await env.DB.prepare('SELECT id FROM mcp_event_subscriptions WHERE id = ?').bind(activeId).first()).toBeNull();
  });

  it('rejects failed verification, rotates signatures and expires subscriptions', async () => {
    const owner = await provision('events-refresh@test.com'), projectId = await createProject(owner), role = await createRole(owner, projectId, 'Receiver');
    const params = { name: 'role.messages.received', arguments: { project_id: projectId, recipient_role_id: role.id }, delivery: { mode: 'webhook', url: 'https://receiver.example/events-refresh', secret: signingSecret } };
    vi.mocked(webhookPost).mockResolvedValueOnce({ status: 200, body: '{"challenge":"wrong"}' });
    expect((await eventRpc(owner, 'events/subscribe', params)).body.error).toMatchObject({ code: -32015, data: { reason: 'challenge_failed' } });
    const id = (await eventRpc(owner, 'events/subscribe', params)).body.result.id;
    const rotated = 'whsec_' + btoa('abcdefghijklmnopqrstuvwxyz123456');
    expect((await eventRpc(owner, 'events/subscribe', { ...params, delivery: { ...params.delivery, secret: rotated } })).body.result.id).toBe(id);
    const row = await env.DB.prepare('SELECT * FROM mcp_event_subscriptions WHERE id = ?').bind(id).first<any>();
    expect((await signedHeaders(row, 'evt_test', '{}'))['webhook-signature'].split(' ')).toHaveLength(2);
    await env.DB.prepare('UPDATE mcp_event_subscriptions SET expires_at = 0 WHERE id = ?').bind(id).run();
    await deliverMessageEvents(env);
    expect(await env.DB.prepare('SELECT id FROM mcp_event_subscriptions WHERE id = ?').bind(id).first()).toBeNull();
  });
});
