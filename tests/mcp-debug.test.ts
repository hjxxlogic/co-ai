import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { Hono } from 'hono';
import app from '../src/index';
import type { AppEnv, Env } from '../src/types';
import { mcpDebug, cleanupMcpDebugLogs } from '../src/mcp-debug';

let runtime: Miniflare;
let env: Env;
const admin = 'mcp-debug-admin-secret-with-at-least-32-characters';
const headers = { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

beforeAll(async () => {
  runtime = new Miniflare({ workers: [{ config: {
    name: 'mcp-debug-test', compatibilityDate: '2026-10-11',
    manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: 'export default { fetch() { return new Response("test"); } }' } } },
    env: { DB: { type: 'd1', id: 'debug-db' } },
  } }] });
  env = { ...await runtime.getBindings(), ADMIN_TOKEN: admin, MCP_DEBUG_LOGS: 'true' } as unknown as Env;
  const sql = await readFile(new URL('../migrations/0010_mcp_debug_logs.sql', import.meta.url), 'utf8');
  await env.DB.exec(sql.split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join(';\n') + ';');
});
afterAll(async () => { await runtime.dispose(); });

async function logged(id: string) {
  const row = await env.DB.prepare('SELECT * FROM mcp_debug_logs WHERE id = ?').bind(id).first<any>();
  const { results } = await env.DB.prepare('SELECT direction, sequence, content FROM mcp_debug_log_chunks WHERE log_id = ? ORDER BY direction, sequence').bind(id).all<{ direction: string; sequence: number; content: string }>();
  return { row, request: results.filter((part) => part.direction === 'request').map((part) => part.content).join(''), response: results.filter((part) => part.direction === 'response').map((part) => part.content).join('') };
}
const request = (message: unknown, additional: Record<string, string> = {}) => app.request('https://co-ai.test/mcp', { method: 'POST', headers: { ...headers, ...additional }, body: JSON.stringify(message) }, env);

describe('MCP debug capture', () => {
  it('records full requests and JSON responses with a shared identifier and redacts credentials', async () => {
    const response = await request({ jsonrpc: '2.0', id: 7, method: 'ping', params: { secret: 'private-webhook-secret' } }, { 'X-Api-Secret': 'custom-header-secret' });
    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 7, result: {} });
    const capture = await logged(response.headers.get('X-MCP-Request-Id')!);
    expect(capture.row).toMatchObject({ method: 'POST', rpc_method: 'ping', response_status: 200, state: 'completed' });
    expect(JSON.parse(capture.request)).toMatchObject({ method: 'ping', params: { secret: '[REDACTED]' } });
    expect(JSON.parse(capture.response)).toEqual({ jsonrpc: '2.0', id: 7, result: {} });
    expect(JSON.stringify(capture)).not.toContain(admin);
    expect(JSON.stringify(capture)).not.toContain('custom-header-secret');
    expect(JSON.stringify(capture)).not.toContain('private-webhook-secret');
  });

  it('captures authentication failures, malformed JSON, HTTPS enforcement and preflight responses', async () => {
    const denied = await request({ jsonrpc: '2.0', id: 1, method: 'events/subscribe', params: { delivery: { secret: 'whsec_abcdefghijklmnop', url: 'https://receiver.example/private-callback-path' } } }, { Authorization: '' });
    expect(denied.status).toBe(401);
    await denied.text();
    const capture = await logged(denied.headers.get('X-MCP-Request-Id')!);
    expect(capture.row.state).toBe('completed');
    expect(JSON.parse(capture.response).error.code).toBe(401);
    expect(capture.request).not.toContain('private-callback-path');
    expect(capture.request).not.toContain('whsec_abcdefghijklmnop');
    const malformed = await app.request('https://co-ai.test/mcp', { method: 'POST', headers, body: '{"password":"do-not-log-this"' }, env);
    await malformed.text();
    expect((await logged(malformed.headers.get('X-MCP-Request-Id')!)).request).not.toContain('do-not-log-this');
    for (const [url, method, status] of [['http://co-ai.test/mcp', 'POST', 426], ['https://co-ai.test/mcp', 'OPTIONS', 204]] as const) {
      const response = await app.request(url, { method }, env);
      await response.text();
      expect((await logged(response.headers.get('X-MCP-Request-Id')!)).row).toMatchObject({ response_status: status, state: 'completed' });
    }
  });

  it('stores large responses in ordered chunks, including redaction inside duplicated tool result text', async () => {
    const mock = new Hono<AppEnv>();
    mock.use('*', mcpDebug);
    const key = 'coai_' + 'a'.repeat(64), content = '汉字'.repeat(30_000);
    mock.post('/mcp', (c) => c.json({ result: { structuredContent: { api_key: key, content }, content: [{ type: 'text', text: JSON.stringify({ api_key: key, content }) }] } }));
    const response = await mock.request('https://co-ai.test/mcp', { method: 'POST', headers, body: '{"method":"tools/call"}' }, env);
    const actual = await response.json() as any;
    expect(actual.result.structuredContent.api_key).toBe(key);
    const capture = await logged(response.headers.get('X-MCP-Request-Id')!);
    const captured = JSON.parse(capture.response);
    expect(captured.result.structuredContent.content).toBe(content);
    expect(JSON.parse(captured.result.content[0].text).content).toBe(content);
    expect(capture.response).not.toContain(key);
    expect(capture.response.length).toBeGreaterThan(100_000);
  });

  it('records SSE frames across split UTF-8 chunks without buffering the connection or altering its bytes', async () => {
    const mock = new Hono<AppEnv>();
    mock.use('*', mcpDebug);
    const payload = ': heartbeat\n\nevent: message\ndata: {"result":{"text":"角色消息","secret":"private-sse-secret"}}\n\n';
    const bytes = new TextEncoder().encode(payload);
    mock.get('/mcp', () => new Response(new ReadableStream({ start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
      controller.close();
    } }), { headers: { 'Content-Type': 'text/event-stream' } }));
    const response = await mock.request('https://co-ai.test/mcp', { headers: { Accept: 'text/event-stream' } }, env);
    expect(await response.text()).toBe(payload);
    const capture = await logged(response.headers.get('X-MCP-Request-Id')!);
    expect(capture.row.state).toBe('completed');
    expect(capture.response).toContain(': heartbeat');
    expect(capture.response).toContain('角色消息');
    expect(capture.response).not.toContain('private-sse-secret');
    expect(capture.response).toContain('[REDACTED]');
  });

  it('closes cancelled streams and leaves ordinary REST requests and disabled debugging alone', async () => {
    const mock = new Hono<AppEnv>();
    mock.use('*', mcpDebug);
    const cancel = vi.fn();
    mock.get('/mcp', () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(': connected\n\n')); }, cancel }), { headers: { 'Content-Type': 'text/event-stream' } }));
    const response = await mock.request('https://co-ai.test/mcp', {}, env);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect((await logged(response.headers.get('X-MCP-Request-Id')!)).row.state).toBe('cancelled');
    const disabled = await request({ jsonrpc: '2.0', id: 1, method: 'ping' });
    await disabled.text();
    const ping = await app.request('https://co-ai.test/mcp', { method: 'POST', headers, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' }, { ...env, MCP_DEBUG_LOGS: 'false' });
    expect(ping.headers.has('X-MCP-Request-Id')).toBe(false);
    const health = await app.request('https://co-ai.test/health', {}, env);
    expect(health.headers.has('X-MCP-Request-Id')).toBe(false);
    await env.DB.prepare('UPDATE mcp_debug_logs SET expires_at = 0 WHERE id = ?').bind(disabled.headers.get('X-MCP-Request-Id')).run();
    await cleanupMcpDebugLogs(env);
    expect(await env.DB.prepare('SELECT id FROM mcp_debug_logs WHERE id = ?').bind(disabled.headers.get('X-MCP-Request-Id')).first()).toBeNull();
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM mcp_debug_log_chunks WHERE log_id = ?').bind(disabled.headers.get('X-MCP-Request-Id')).first<any>()).n).toBe(0);
  });
});
