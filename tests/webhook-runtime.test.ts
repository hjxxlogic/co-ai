import { expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { webhookTlsOptions } from '../src/event-webhook';

it('accepts webhook TLS options in workerd without unsupported Node options', async () => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'webhook-tls-test', compatibilityDate: '2026-10-11', compatibilityFlags: ['nodejs_compat'],
    manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: `
      import { TLSSocket } from 'node:tls';
      export default { async fetch(request) {
        const options = await request.json();
        try {
          const socket = new TLSSocket(undefined, options);
          socket.on('error', () => {});
          socket.destroy();
          return Response.json({ accepted: true });
        } catch (error) { return Response.json({ accepted: false, error: error.message }); }
      } };
    ` } } },
  } }] });
  try {
    const validate = async (options: unknown) => {
      const response = await runtime.dispatchFetch('https://runtime.test/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options) });
      return response.json() as Promise<{ accepted: boolean; error?: string }>;
    };
    const options = webhookTlsOptions('receiver.example', '8.8.8.8');
    expect(await validate(options)).toEqual({ accepted: true });
    const unsupported = await validate({ ...options, ALPNProtocols: ['http/1.1'] });
    expect(unsupported.accepted).toBe(false);
    expect(unsupported.error).toContain('ALPNProtocols');
  } finally { await runtime.dispose(); }
});
