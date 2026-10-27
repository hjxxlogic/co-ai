import { afterAll, beforeAll, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { readFile, readdir } from 'node:fs/promises';
import { eventStream } from '../src/events-stream';

let mf: Miniflare;
let db: D1Database;
const admin = 'rest-events-admin-secret-with-at-least-32-characters';
const streams: ReadableStreamDefaultReader<Uint8Array>[] = [];
async function request(path: string, key?: string, method = 'GET', data?: unknown) {
  return mf.dispatchFetch('https://co-ai.test' + path, { method,
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) },
    body: data ? JSON.stringify(data) : undefined,
  });
}
async function create(path: string, key: string, data: unknown) {
  const response = await request(path, key, 'POST', data);
  expect(response.status).toBe(201);
  return (await response.json() as any).data;
}
async function fixture() {
  const user = await create('/api/admin/users', admin, { name: 'Events', email: crypto.randomUUID() + '@test.com' });
  const key = user.key.api_key;
  const project = await create('/api/v1/projects', key, { name: 'Events' });
  const base = `/api/v1/projects/${project.id}`;
  const a = await create(base + '/roles', key, { name: 'A' });
  const b = await create(base + '/roles', key, { name: 'B' });
  return { key, project, base, a, b, user };
}
const path = (project: string, role: string) => `/api/v1/events/stream?name=role.messages.received&project_id=${project}&recipient_role_id=${role}`;
async function connect(key: string, project: string, role: string) {
  const response = await request(path(project, role), key);
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store, no-transform');
  const reader = response.body!.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  streams.push(reader);
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: ready');
  return reader;
}
async function next(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const result = await reader.read();
  return new TextDecoder().decode(result.value);
}

beforeAll(async () => {
  const bundled = await build({ stdin: { resolveDir: process.cwd(), contents: `
    import app from './src/index';
    import { EventsLive as Base } from './src/events-live';
    export default app;
    // Test-only introspection proves instance replacement without closing sockets.
    export class EventsLive extends Base {
      constructor(state) { super(state); this.testState = state; this.marker = crypto.randomUUID(); }
      async fetch(request) {
        if (new URL(request.url).pathname === '/test-state') return Response.json({
          marker: this.marker, filters: this.testState.getWebSockets().map(socket => socket.deserializeAttachment()),
        });
        return super.fetch(request);
      }
    }
  ` }, bundle: true, write: false, format: 'esm', platform: 'browser', external: ['node:*'] });
  mf = new Miniflare({ workers: [{ config: {
    name: 'rest-events-test', compatibilityDate: '2026-10-11', compatibilityFlags: ['nodejs_compat'],
    manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: bundled.outputFiles[0].text } } },
    exports: { EventsLive: { type: 'durable-object', storage: 'sqlite', unsafePreventEviction: false } },
    env: { DB: { type: 'd1', id: 'rest-events-db' }, FILES: { type: 'r2', name: 'files' },
      ADMIN_TOKEN: { type: 'text', value: admin }, EVENTS_LIVE: { type: 'durable-object', worker: 'rest-events-test', exportName: 'EventsLive' } },
  } }] });
  db = (await mf.getBindings()).DB as unknown as D1Database;
  for (const file of (await readdir('migrations')).filter(file => file.endsWith('.sql')).sort()) {
    const sql = await readFile('migrations/' + file, 'utf8');
    await db.exec(sql.replace(/^--.*$/gm, '').replace(/\s+/g, ' ').trim());
  }
});
afterAll(async () => {
  await Promise.all(streams.map(reader => reader.cancel().catch(() => {})));
  await mf?.dispose();
});

it('delivers immediate role-specific hints to multiple real Worker/DO connections, with ALL deduplication and sender exclusion', async () => {
  const f = await fixture();
  const a = await connect(f.key, f.project.id, f.a.id);
  const a2 = await connect(f.key, f.project.id, f.a.id);
  const b = await connect(f.key, f.project.id, f.b.id);
  await create(f.base + '/items', f.key, { title: 'No event', kind: 'note' });
  const note = await create(f.base + '/items', f.key, { title: 'Later becomes message' });
  expect((await request(f.base + '/items/' + note.id, f.key, 'PATCH', { version: 1, kind: 'message' })).status).toBe(200);
  expect((await request(f.base + '/items', f.key, 'POST', { title: 'Invalid recipients', kind: 'message', recipient_role_ids: [crypto.randomUUID()] })).status).toBe(400);
  const direct = await create(f.base + '/items', f.key, { title: 'Private message', content: 'Never in event', kind: 'message', role_id: f.b.id, recipient_role_ids: [f.a.id] });
  for (const reader of [a, a2]) {
    const frame = await next(reader);
    expect(frame).toContain(`evt_message_${direct.id}_${f.a.id}`);
    expect(frame).not.toContain('Never in event');
    const data = JSON.parse(frame.split('data: ')[1]);
    expect(data.data).toMatchObject({ recipient_role_id: f.a.id, message_count: 1, first_message_id: direct.id, last_message_id: direct.id });
  }
  const broadcast = await create(f.base + '/items', f.key, { title: 'Broadcast', kind: 'message', recipient_role_ids: ['ALL', f.a.id] });
  for (const reader of [a, a2, b]) expect(await next(reader)).toContain(broadcast.id);
  const last = await create(f.base + '/items', f.key, { title: 'Next', kind: 'message' });
  for (const reader of [a, a2, b]) expect(await next(reader)).toContain(last.id);
  await Promise.all([a, a2, b].map(reader => reader.cancel()));
});

it('enforces authentication, project/role boundaries, strict parameters, and rejects replay', async () => {
  const f = await fixture();
  expect((await request('/api/v1/events')).status).toBe(401);
  const catalog = await request('/api/v1/events', f.key);
  expect((await catalog.json() as any).data[0].delivery).toEqual(['sse']);
  const other = await fixture();
  expect((await request(path(f.project.id, f.a.id), other.key)).status).toBe(404);
  expect((await request(path(f.project.id, other.a.id), f.key)).status).toBe(404);
  const projectKey = await create(other.base + '/keys', other.key, { name: 'Reader', permission: 'read' });
  expect((await request(path(f.project.id, f.a.id), projectKey.api_key)).status).toBe(404);
  for (const suffix of ['&unknown=1', '&name=role.messages.received', '&recipient_role_id=ALL']) {
    expect((await request(path(f.project.id, f.a.id) + suffix, f.key)).status).toBe(400);
  }
  expect((await mf.dispatchFetch('https://co-ai.test' + path(f.project.id, f.a.id), { headers: { Authorization: `Bearer ${f.key}`, 'Last-Event-ID': 'old' } })).status).toBe(400);
  await request(f.base + '/roles/' + f.a.id, f.key, 'PATCH', { archived: true });
  expect((await request(path(f.project.id, f.a.id), f.key)).status).toBe(404);
  await request(f.base, f.key, 'PATCH', { archived: true });
  expect((await request(path(f.project.id, f.b.id), f.key)).status).toBe(404);
});

it('rejects invalid and oversized notification bodies without affecting subsequent delivery', async () => {
  const f = await fixture();
  const reader = await connect(f.key, f.project.id, f.a.id);
  const ns = (await mf.getBindings()).EVENTS_LIVE as unknown as DurableObjectNamespace;
  const stub = ns.get(ns.idFromName(f.project.id));
  for (const body of ['{', 'null', '{}']) {
    expect((await stub.fetch('https://events-live/notify', { method: 'POST', body })).status).toBe(400);
  }
  // Limits count UTF-8 bytes, not JavaScript characters.
  expect((await stub.fetch('https://events-live/notify', { method: 'POST', body: '中'.repeat(1366) })).status).toBe(413);
  expect((await stub.fetch('https://events-live/notify', { method: 'POST', body: ' '.repeat(4096) })).status).toBe(400);
  const message = await create(f.base + '/items', f.key, { title: 'After invalid notices', kind: 'message' });
  expect(await next(reader)).toContain(message.id);
  await reader.cancel();
});

it('limits real DO connections per user and frees capacity when the Worker bridge is cancelled', async () => {
  const ns = (await mf.getBindings()).EVENTS_LIVE as unknown as DurableObjectNamespace;
  const project = crypto.randomUUID(), role = crypto.randomUUID(), principal = crypto.randomUUID();
  const stub = ns.get(ns.idFromName(project));
  const url = `https://events-live/events?name=role.messages.received&project_id=${project}&recipient_role_id=${role}&principal_id=${principal}`;
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const open = async () => {
    const response = await stub.fetch(url, { headers: { Upgrade: 'websocket' } });
    expect(response.status).toBe(101);
    const reader = eventStream(response.webSocket!, new AbortController().signal).body!.getReader();
    streams.push(reader); readers.push(reader);
    expect(await next(reader)).toContain('event: ready');
  };
  for (let i = 0; i < 16; i++) await open();
  const limited = await stub.fetch(url, { headers: { Upgrade: 'websocket' } });
  expect(limited.status).toBe(429);
  expect(limited.headers.get('Retry-After')).toBe('30');
  await readers.pop()!.cancel();
  await open();
  await Promise.all(readers.map(reader => reader.cancel()));
});

it('reauthorizes reconnects after key revocation or account disable while an existing stream has a bounded permission window', async () => {
  const f = await fixture();
  const credential = await create(f.base + '/keys', f.key, { name: 'Reader', permission: 'read' });
  const reader = await connect(credential.api_key, f.project.id, f.a.id);
  expect((await request('/api/v1/keys/' + credential.id, f.key, 'DELETE')).status).toBe(204);
  expect((await request(path(f.project.id, f.a.id), credential.api_key)).status).toBe(401);
  const message = await create(f.base + '/items', f.key, { title: 'Within existing stream window', kind: 'message' });
  expect(await next(reader)).toContain(message.id);
  await reader.cancel();
  expect((await request('/api/admin/users/' + f.user.user.id, admin, 'PATCH', { disabled: true })).status).toBe(200);
  expect((await request(path(f.project.id, f.a.id), f.key)).status).toBe(401);
});

it('recovers all pages after ready, merges concurrent hints, and catches up after disconnect using sync_until', async () => {
  const f = await fixture();
  const messages = [];
  for (let i = 0; i < 3; i++) messages.push(await create(f.base + '/items', f.key, { title: `Initial ${i}`, kind: 'message' }));
  const reader = await connect(f.key, f.project.id, f.a.id);
  const query = `${f.base}/items?recipient_role_id=${f.a.id}&include_deleted=true&updated_since=2000-01-01T00:00:00Z&limit=1`;
  let page = await (await request(query, f.key)).json() as any;
  const found = new Set(page.data.map((item: any) => item.id));
  const during = await create(f.base + '/items', f.key, { title: 'During pagination', kind: 'message' });
  expect(await next(reader)).toContain(during.id);
  found.add(during.id);
  while (page.next_cursor) {
    page = await (await request(query + '&after=' + encodeURIComponent(page.next_cursor), f.key)).json() as any;
    for (const item of page.data) found.add(item.id);
  }
  for (const item of messages) expect(found.has(item.id)).toBe(true);
  const checkpoint = page.sync_until;
  expect(checkpoint).toBeTruthy();
  await reader.cancel();
  const offline = await create(f.base + '/items', f.key, { title: 'Offline', kind: 'message' });
  const reconnected = await connect(f.key, f.project.id, f.a.id);
  const changes = await (await request(`${f.base}/items?recipient_role_id=${f.a.id}&include_deleted=true&updated_since=${encodeURIComponent(checkpoint)}`, f.key)).json() as any;
  expect(changes.data.some((item: any) => item.id === offline.id)).toBe(true);
  await reconnected.cancel();
});


it('keeps existing connections, attachments and limits after real workerd idle hibernation replaces the instance', async () => {
  const ns = (await mf.getBindings()).EVENTS_LIVE as unknown as DurableObjectNamespace;
  const project = crypto.randomUUID(), role = crypto.randomUUID(), principal = crypto.randomUUID();
  const stub = ns.get(ns.idFromName(project));
  const url = `https://events-live/events?name=role.messages.received&project_id=${project}&recipient_role_id=${role}&principal_id=${principal}`;
  const readers = [];
  for (let i = 0; i < 16; i++) {
    const response = await stub.fetch(url, { headers: { Upgrade: 'websocket' } });
    const reader = eventStream(response.webSocket!, new AbortController().signal).body!.getReader();
    readers.push(reader); streams.push(reader);
    await next(reader);
  }
  const before = await (await stub.fetch('https://events-live/test-state')).json() as any;
  // Workerd evicts idle JS instances after 10 seconds when eviction is enabled.
  // Heartbeats run in the ordinary Worker and never wake the DO.
  await new Promise(resolve => setTimeout(resolve, 12000));
  const after = await (await stub.fetch('https://events-live/test-state')).json() as any;
  expect(after.marker).not.toBe(before.marker);
  expect(after.filters).toEqual(before.filters);
  expect((await stub.fetch(url, { headers: { Upgrade: 'websocket' } })).status).toBe(429);
  const message = crypto.randomUUID();
  expect((await stub.fetch('https://events-live/notify', { method: 'POST', body: JSON.stringify({
    project_id: project, message_id: message, timestamp: new Date().toISOString(), sender_role_id: null, recipient_role_ids: ['ALL'],
  }) })).status).toBe(204);
  for (const reader of readers) expect(await next(reader)).toContain(message);
  await Promise.all(readers.map(reader => reader.cancel()));
});
