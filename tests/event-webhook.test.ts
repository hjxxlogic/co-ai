import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { callbackUrl, webhookPost } from '../src/event-webhook';
import { signedHeaders } from '../src/mcp-events';

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('event webhook security', () => {
  it('blocks local, private, mapped, special-use and credential-bearing destinations', () => {
    for (const url of ['http://example.com', 'https://localhost', 'https://127.0.0.1', 'https://[::ffff:127.0.0.1]', 'https://user:pass@example.com', 'https://example.com:444', 'https://example.com/#fragment']) expect(() => callbackUrl(url)).toThrow();
  });

  it('posts through fetch without a public-address precheck or following redirects', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 302, headers: { Location: 'https://localhost/' } }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await webhookPost('https://receiver.example/callback', '{}', { 'Content-Type': 'application/json' })).toEqual({ status: 302, body: '' });
    expect(fetchMock).toHaveBeenCalledWith('https://receiver.example/callback', expect.objectContaining({
      method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' }, redirect: 'manual', signal: expect.any(AbortSignal),
    }));
  });

  it('returns the response body and rejects responses over 64 KiB', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('{"challenge":"ok"}', { status: 200 }))
      .mockResolvedValueOnce(new Response('x'.repeat(64 * 1024 + 1), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await webhookPost('https://receiver.example/callback', '{}', {})).toEqual({ status: 200, body: '{"challenge":"ok"}' });
    await expect(webhookPost('https://receiver.example/callback', '{}', {})).rejects.toThrow('Callback response too large');
  });

  it('labels address, HTTP and response failures without exposing callback details', async () => {
    const url = 'https://receiver.example/private-callback';
    const refused = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(refused)
      .mockRejectedValueOnce(new Error('destination address is private'))
      .mockRejectedValueOnce(new DOMException('deadline', 'TimeoutError'))
      .mockResolvedValueOnce(new Response('x'.repeat(64 * 1024 + 1))));
    await expect(webhookPost(url, '{}', {})).rejects.toMatchObject({ stage: 'http_request', reason: 'transport_failed', errorCode: 'ECONNREFUSED' });
    await expect(webhookPost(url, '{}', {})).rejects.toMatchObject({ stage: 'http_request', reason: 'address_rejected' });
    await expect(webhookPost(url, '{}', {})).rejects.toMatchObject({ stage: 'http_request', reason: 'timeout' });
    await expect(webhookPost(url, '{}', {})).rejects.toMatchObject({ stage: 'response_read', reason: 'response_too_large', responseStatus: 200 });
  });

  it('signs exact body bytes using the Standard Webhooks HMAC format', async () => {
    const secret = 'whsec_' + Buffer.from('12345678901234567890123456789012').toString('base64');
    const body = '{"message":"角色收到消息"}';
    const headers = await signedHeaders({ id: 'sub_test', secret, previous_secret: null, rotation_until: 0 }, 'evt_test', body);
    const expected = createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`evt_test.${headers['webhook-timestamp']}.${body}`).digest('base64');
    expect(headers['webhook-signature']).toBe(`v1,${expected}`);
    expect(headers['webhook-id']).toBe('evt_test');
  });
});
