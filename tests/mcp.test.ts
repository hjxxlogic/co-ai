import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import app from '../src/index';
import openapi from '../llm/openapi.json';
import { restTools } from '../src/mcp-tools';
import type { Env } from '../src/types';

const admin = 'protocol-test-admin-secret-at-least-32-characters';
const env = { ADMIN_TOKEN: admin, DOCS: { fetch: async () => new Response('Public API documentation') } } as unknown as Env;
const rpcHeaders = { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
async function rpc(message: unknown, headers: Record<string, string> = {}) {
  return app.request('https://co-ai.test/mcp', { method: 'POST', headers: { ...rpcHeaders, ...headers }, body: JSON.stringify(message) }, env);
}

function call(name: string, args: Record<string, unknown> = {}) {
  return rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
}

describe('MCP Streamable HTTP protocol', () => {
  it('challenges anonymous initialization, discovery and SSE before connecting, including client Origins', async () => {
    for (const method of ['GET', 'POST']) {
      for (const origin of [undefined, 'https://grok.com', 'https://co-ai.test']) {
        const response = await app.request('https://co-ai.test/mcp', {
          method, headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(origin ? { Origin: origin } : {}) },
          body: method === 'POST' ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'Grok', version: '1' } } }) : undefined,
        }, env);
        expect(response.status).toBe(401);
        expect(response.headers.get('WWW-Authenticate')).toContain('resource_metadata="https://co-ai.test/.well-known/oauth-protected-resource/mcp"');
        expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      }
    }
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Authorization: '' })).status).toBe(401);
  });

  it('connects an official MCP client and reads tools and documentation without server sessions', async () => {
    const client = new Client({ name: 'co-ai-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL('https://co-ai.test/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${admin}` } },
      fetch: async (url, init) => app.request(String(url), init, env),
    });
    try {
      await client.connect(transport);
      expect(transport.sessionId).toBeUndefined();
      expect(client.getServerCapabilities()).toEqual({ tools: {}, resources: {} });
      const catalog = await client.listTools();
      const operationIds = Object.values(openapi.paths).flatMap((operations) => Object.values(operations).map((operation) => operation.operationId));
      expect(catalog.tools.map((tool) => tool.name).sort()).toEqual(operationIds.sort());
      expect(new Set(catalog.tools.map((tool) => tool.name)).size).toBe(operationIds.length);
      const health = await client.callTool({ name: 'get_health', arguments: {} });
      expect(health.structuredContent).toEqual({ status: 200, body: { status: 'ok' } });
      expect(health.isError).toBe(false);
      const resources = await client.listResources();
      expect(resources.resources).toHaveLength(3);
      expect(resources.resources.map((resource) => resource.uri)).toContain('https://co-ai.test/llm/API.md');
      const document = await client.readResource({ uri: 'https://co-ai.test/llm/API.md' });
      expect(document.contents[0]).toMatchObject({ text: 'Public API documentation', mimeType: 'text/plain' });
    } finally { await client.close(); }
  });

  it('enforces HTTPS, allowed methods, content negotiation, protocol versions and Origin', async () => {
    const insecure = await app.request('http://co-ai.test/mcp', { method: 'POST' }, env);
    expect(insecure.status).toBe(426);
    expect(insecure.headers.get('Location')).toBeNull();
    for (const method of ['DELETE', 'PUT']) {
      const response = await app.request('https://co-ai.test/mcp', { method }, env);
      expect(response.status).toBe(405);
      expect(response.headers.get('Allow')).toBe('GET, POST');
    }
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Accept: 'application/json' })).status).toBe(406);
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'MCP-Protocol-Version': 'invalid' })).status).toBe(400);
    const denied = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'https://evil.test' });
    expect(denied.status).toBe(403);
    expect((await denied.json() as any).error.documentation).toBe('https://co-ai.test/llm');
    const csrf = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Cookie: '__Host-coai_session=untrusted' });
    expect(csrf.status).toBe(403);
    expect((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    const ping = await rpc({ jsonrpc: '2.0', id: 0, method: 'ping' });
    expect(await ping.json()).toEqual({ jsonrpc: '2.0', id: 0, result: {} });
  });

  it('opens GET SSE with heartbeats, rotates idle streams and closes aborted connections', async () => {
    vi.useFakeTimers();
    try {
      const response = await app.request('https://co-ai.test/mcp', { headers: { Authorization: `Bearer ${admin}`, Accept: 'text/event-stream' } }, env);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/event-stream');
      expect(response.headers.get('Cache-Control')).toContain('no-transform');
      expect(response.headers.get('Mcp-Session-Id')).toBeNull();
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(': connected');
      await vi.advanceTimersByTimeAsync(15_000);
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(':');
      await vi.advanceTimersByTimeAsync(45_000);
      while (!(await reader.read()).done) { /* Drain buffered heartbeats. */ }
      expect(vi.getTimerCount()).toBe(0);

      const abort = new AbortController();
      const aborted = await app.request('https://co-ai.test/mcp', { signal: abort.signal, headers: { Authorization: `Bearer ${admin}`, Accept: 'text/event-stream' } }, env);
      const abortedReader = aborted.body!.getReader();
      await abortedReader.read();
      abort.abort();
      expect((await abortedReader.read()).done).toBe(true);
      expect(vi.getTimerCount()).toBe(0);

      const cancelled = await app.request('https://co-ai.test/mcp', { headers: { Authorization: `Bearer ${admin}`, Accept: 'text/event-stream' } }, env);
      await cancelled.body!.cancel();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('validates GET SSE negotiation, protocol versions and Origin', async () => {
    for (const [headers, status] of [
      [{ Accept: 'application/json' }, 406],
      [{ Accept: 'text/event-stream', 'MCP-Protocol-Version': 'invalid' }, 400],
      [{ Accept: 'text/event-stream', Origin: 'https://evil.test' }, 403],
    ] as [Record<string, string>, number][]) {
      expect((await app.request('https://co-ai.test/mcp', { headers: { Authorization: `Bearer ${admin}`, ...headers } }, env)).status).toBe(status);
    }
  });

  it('returns POST results as SSE when listed first in Accept and works with the official client', async () => {
    const response = await rpc({ jsonrpc: '2.0', id: 7, method: 'ping' }, { Accept: 'text/event-stream, application/json' });
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    const data = (await response.text()).split('\n').find((line) => line.startsWith('data: '))!;
    expect(JSON.parse(data.slice(6))).toEqual({ jsonrpc: '2.0', id: 7, result: {} });
    const client = new Client({ name: 'sse-test', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL('https://co-ai.test/mcp'), {
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set('Accept', 'text/event-stream, application/json');
        headers.set('Authorization', `Bearer ${admin}`);
        return app.request(String(url), { ...init, headers }, env);
      },
    });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.length).toBe(restTools.length);
      expect((await client.callTool({ name: 'get_health', arguments: {} })).structuredContent).toEqual({ status: 200, body: { status: 'ok' } });
    } finally { await client.close(); }
  });

  it('rejects malformed requests, unknown methods/tools, invalid inputs and resource URLs', async () => {
    const invalidJson = await app.request('https://co-ai.test/mcp', { method: 'POST', headers: rpcHeaders, body: '{' }, env);
    expect(invalidJson.status).toBe(400);
    const unknownMethod = await rpc({ jsonrpc: '2.0', id: 1, method: 'unknown/method' });
    expect((await unknownMethod.json() as any).error.code).toBe(-32601);
    for (const [name, args] of [
      ['unknown', {}],
      ['get_health', { extra: true }],
      ['get_api_v1_projects_projectId', {}],
      ['get_api_v1_projects_projectId', { projectId: '..' }],
      ['get_api_v1_projects_projectId', { projectId: 'a/b' }],
      ['post_api_v1_projects_projectId_attachments', { projectId: 'p', filename: 'x', content_base64: 'invalid!' }],
      ['post_api_v1_projects_projectId_attachments', { projectId: 'p', filename: 'x', content_base64: 'Zh==' }],
      ['get_api_v1_projects_projectId_items', { projectId: 'p', limit: 101 }],
    ] as [string, Record<string, unknown>][]) {
      const response = await call(name, args);
      expect((await response.json() as any).error.code, name).toBe(-32602);
    }
    const external = await rpc({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'https://evil.test/private' } });
    expect((await external.json() as any).error.code).toBe(-32602);
  });

  it('describes complete REST input schemas, binary transfers and destructive operations', () => {
    const list = restTools.find((entry) => entry.tool.name === 'get_api_v1_projects_projectId_items')!;
    expect(Object.keys(list.tool.inputSchema.properties!)).toEqual(expect.arrayContaining(['projectId', 'tag', 'recipient_role_id', 'updated_since', 'after', 'max_items']));
    expect(JSON.stringify(restTools.map((entry) => entry.tool.inputSchema))).not.toContain('"$ref"');
    const upload = restTools.find((entry) => entry.binaryUpload)!;
    expect(upload.tool.inputSchema.required).toEqual(['projectId', 'filename', 'content_base64']);
    const deletion = restTools.find((entry) => entry.tool.name === 'delete_api_v1_projects_projectId_items_itemId')!;
    expect(deletion.tool.inputSchema.properties!.body).toMatchObject({ required: ['version'] });
    expect(deletion.tool.annotations!.destructiveHint).toBe(true);
  });
});
