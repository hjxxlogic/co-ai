import type { MiddlewareHandler } from 'hono';
import type { AppEnv, Env } from './types';

const maxBodyBytes = 16 * 1024 * 1024;
const chunkCharacters = 8192;
const privateField = /authorization|cookie|password|credential|secret|token|signature|challenge|api[_-]?key|content_base64/i;
const credentialPattern = /\b(?:coai_|coao_(?:code_|client_)?|coar_|coau_)[a-f0-9]{64}\b|\bwhsec_[A-Za-z0-9+/]+={0,2}/g;

class Redactor {
  private secrets = new Set<string>();
  constructor(request: Request, adminToken: string) {
    if (adminToken) this.secrets.add(adminToken);
    const bearer = /^Bearer (.+)$/i.exec(request.headers.get('Authorization') ?? '')?.[1];
    if (bearer) this.secrets.add(bearer);
    for (const cookie of (request.headers.get('Cookie') ?? '').split(';')) {
      const value = cookie.slice(cookie.indexOf('=') + 1).trim();
      if (value) this.secrets.add(value);
    }
  }
  private collect(value: unknown, depth = 0) {
    if (depth > 64 || !value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      if (privateField.test(key) && typeof entry === 'string' && entry) this.secrets.add(entry);
      else this.collect(entry, depth + 1);
    }
  }
  text(value: string): string {
    let result = value.replace(credentialPattern, '[REDACTED]');
    for (const secret of this.secrets) result = result.split(secret).join('[REDACTED]');
    return result;
  }
  value(value: unknown, depth = 0, parent = ''): unknown {
    if (depth > 64) return '[OMITTED: nesting limit]';
    if (depth === 0) this.collect(value);
    if (typeof value === 'string') {
      // Tool results duplicate structuredContent as JSON inside content[].text.
      if (/^\s*[\[{]/.test(value)) {
        try { return JSON.stringify(this.value(JSON.parse(value), depth + 1)); }
        catch { return '[OMITTED: invalid embedded JSON]'; }
      }
      return this.text(value);
    }
    if (Array.isArray(value)) return value.map((entry) => this.value(entry, depth + 1, parent));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
      privateField.test(key) ? '[REDACTED]'
        : parent === 'delivery' && key === 'url' && typeof entry === 'string' ? this.callback(entry)
        : this.value(entry, depth + 1, key),
    ]));
    return value;
  }
  private callback(value: string) {
    try { return new URL(value).origin + '/[REDACTED callback path]'; }
    catch { return '[REDACTED callback URL]'; }
  }
  headers(headers: Headers) {
    // Custom headers can also contain credentials; record their presence only.
    const publicHeaders = /^(accept|content-type|content-length|origin|user-agent|mcp-method|mcp-name|mcp-protocol-version|cache-control|allow|access-control-[a-z-]+|www-authenticate|x-mcp-request-id)$/i;
    return Object.fromEntries([...headers].map(([key, value]) => [key, publicHeaders.test(key) ? this.text(value) : '[REDACTED]']));
  }
  json(text: string) {
    try { return JSON.stringify(this.value(JSON.parse(text))); }
    catch { return JSON.stringify({ omitted: 'invalid_json', bytes: new TextEncoder().encode(text).byteLength }); }
  }
  sse(frame: string) {
    const lines = frame.split(/\r?\n/), data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
    let included = false;
    return lines.flatMap((line) => {
      if (!line.startsWith('data:')) return [this.text(line)];
      if (included) return [];
      included = true;
      return ['data: ' + this.json(data)];
    }).join('\n') + '\n\n';
  }
}

async function readBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '', size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > maxBodyBytes) {
        void reader.cancel().catch(() => {});
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}

export const mcpDebug: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!['/mcp', '/mcp/'].includes(c.req.path) || c.env.MCP_DEBUG_LOGS !== 'true') return next();
  const id = crypto.randomUUID(), started = Date.now(), redactor = new Redactor(c.req.raw, c.env.ADMIN_TOKEN);
  const sequence = { request: 0, response: 0 };
  let enabled = true;
  const persist = async (work: () => Promise<unknown>) => {
    if (!enabled) return;
    try { await work(); }
    catch { enabled = false; console.warn(JSON.stringify({ event: 'mcp_debug_storage_failed', request_id: id })); }
  };
  const save = async (direction: 'request' | 'response', text: string) => {
    for (let offset = 0; offset < text.length; offset += chunkCharacters) {
      const part = text.slice(offset, offset + chunkCharacters), number = sequence[direction]++;
      await persist(() => c.env.DB.prepare('INSERT INTO mcp_debug_log_chunks (log_id, direction, sequence, content) VALUES (?, ?, ?, ?)').bind(id, direction, number, part).run());
    }
  };
  const url = new URL(c.req.url);
  url.username = ''; url.password = ''; url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (privateField.test(key)) url.searchParams.set(key, '[REDACTED]');
  await persist(() => c.env.DB.prepare('INSERT INTO mcp_debug_logs (id, created_at, expires_at, method, url, request_headers) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, started, started + 86_400_000, c.req.method, redactor.text(url.href), JSON.stringify(redactor.headers(c.req.raw.headers))).run());
  console.info(JSON.stringify({ event: 'mcp_debug_request', request_id: id, method: c.req.method, path: c.req.path }));
  try {
    const text = await readBody(c.req.raw.clone());
    const body = text === null ? JSON.stringify({ omitted: 'body_exceeds_16_MiB' }) : text ? redactor.json(text) : '';
    await save('request', body);
    if (body) {
      const rpc = JSON.parse(body) as { method?: unknown } | null;
      if (rpc && typeof rpc.method === 'string') await persist(() => c.env.DB.prepare('UPDATE mcp_debug_logs SET rpc_method = ? WHERE id = ?').bind(rpc.method, id).run());
    }
  } catch { await save('request', JSON.stringify({ omitted: 'body_read_failed' })); }
  await next();
  c.header('X-MCP-Request-Id', id);
  c.header('Access-Control-Expose-Headers', [c.res.headers.get('Access-Control-Expose-Headers'), 'X-MCP-Request-Id'].filter(Boolean).join(', '));
  const response = c.res;
  const sse = response.headers.get('Content-Type')?.startsWith('text/event-stream');
  await persist(() => c.env.DB.prepare("UPDATE mcp_debug_logs SET response_status = ?, response_headers = ?, state = 'responding' WHERE id = ?")
    .bind(response.status, JSON.stringify(redactor.headers(response.headers)), id).run());
  console.info(JSON.stringify({ event: 'mcp_debug_response', request_id: id, status: response.status, format: sse ? 'sse' : 'json' }));
  let finished = false;
  const finish = async (state: string) => {
    if (finished) return;
    finished = true;
    await persist(() => c.env.DB.prepare('UPDATE mcp_debug_logs SET state = ?, duration_ms = ? WHERE id = ?').bind(state, Date.now() - started, id).run());
    console.info(JSON.stringify({ event: 'mcp_debug_completed', request_id: id, state, response_chunks: sequence.response }));
  };
  if (!response.body) { await finish('completed'); return; }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let text = '', size = 0, omitted = false;
  const capture = async (value: Uint8Array | undefined, done: boolean) => {
    size += value?.byteLength ?? 0;
    if (omitted) return;
    if (size > maxBodyBytes) { omitted = true; text = ''; await save('response', JSON.stringify({ omitted: 'body_exceeds_16_MiB' })); return; }
    text += value ? decoder.decode(value, { stream: true }) : decoder.decode();
    if (sse) {
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(text))) {
        await save('response', redactor.sse(text.slice(0, match.index)));
        text = text.slice(match.index + match[0].length);
      }
      if (done && text) { await save('response', redactor.sse(text)); text = ''; }
    } else if (done) {
      const body = text ? redactor.json(text) : '';
      await save('response', body);
      if (body) {
        const rpc = JSON.parse(body) as { error?: { code?: unknown } } | null;
        if (typeof rpc?.error?.code === 'number') await persist(() => c.env.DB.prepare('UPDATE mcp_debug_logs SET rpc_error_code = ? WHERE id = ?').bind(rpc.error!.code, id).run());
      }
      text = '';
    }
  };
  c.res = new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.value) controller.enqueue(chunk.value);
        await capture(chunk.value, chunk.done);
        if (chunk.done) { await finish('completed'); controller.close(); }
      } catch (error) { await finish('stream_error'); controller.error(error); }
    },
    async cancel(reason) {
      const finishing = finish('cancelled');
      try { await reader.cancel(reason); }
      finally { await finishing; }
    },
  }), { status: response.status, statusText: response.statusText, headers: response.headers });
};

export async function cleanupMcpDebugLogs(env: Env) {
  await env.DB.prepare('DELETE FROM mcp_debug_logs WHERE id IN (SELECT id FROM mcp_debug_logs WHERE expires_at <= ? LIMIT 500)').bind(Date.now()).run();
}
