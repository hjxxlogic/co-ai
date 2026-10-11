import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFile } from 'node:fs/promises';
import app from '../src/index';
import type { Env } from '../src/types';
import { digest } from '../src/security';

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
  for (const file of ['0001_initial.sql', '0002_web_management.sql', '0003_roles_and_tags.sql', '0004_password_login.sql', '0005_recipient_roles.sql']) {
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
    const docs = await request('/llm/README.md');
    expect(docs.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect(await docs.text()).toBe('API docs');
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
