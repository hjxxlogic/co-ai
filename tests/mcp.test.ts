import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import app from '../src/index';
import openapi from '../llm/openapi.json';
import { restTools } from '../src/mcp-tools';
import type { Env } from '../src/types';

const env = { DOCS: { fetch: async () => new Response('Public API documentation') } } as unknown as Env;
const rpcHeaders = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
async function rpc(message: unknown, headers: Record<string, string> = {}) {
  return app.request('https://co-ai.test/mcp', { method: 'POST', headers: { ...rpcHeaders, ...headers }, body: JSON.stringify(message) }, env);
}

function call(name: string, args: Record<string, unknown> = {}) {
  return rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
}

describe('MCP Streamable HTTP protocol', () => {
  it('connects an official MCP client and reads tools and documentation without server sessions', async () => {
    const client = new Client({ name: 'co-ai-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL('https://co-ai.test/mcp'), {
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
    for (const method of ['GET', 'DELETE', 'PUT']) {
      const response = await app.request('https://co-ai.test/mcp', { method }, env);
      expect(response.status).toBe(405);
      expect(response.headers.get('Allow')).toBe('POST');
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
