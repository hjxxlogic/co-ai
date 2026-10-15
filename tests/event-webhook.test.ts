import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve4 } from 'node:dns/promises';
import { createHmac } from 'node:crypto';
import { callbackUrl, publicIpv4, webhookPost } from '../src/event-webhook';
import { signedHeaders } from '../src/mcp-events';

vi.mock('node:dns/promises', () => ({ resolve4: vi.fn() }));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('event webhook security', () => {
  it('blocks local, private, mapped, special-use and credential-bearing destinations', async () => {
    for (const url of ['http://example.com', 'https://localhost', 'https://127.0.0.1', 'https://[::ffff:127.0.0.1]', 'https://user:pass@example.com', 'https://example.com:444', 'https://example.com/#fragment']) expect(() => callbackUrl(url)).toThrow();
    for (const ip of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255']) expect(publicIpv4(ip), ip).toBe(false);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(resolve4).mockResolvedValueOnce(['8.8.8.8', '10.0.0.1']);
    await expect(webhookPost('https://receiver.example/callback', '{}', {})).rejects.toThrow('not public');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts through fetch without following redirects or sending to rejected addresses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 302, headers: { Location: 'https://localhost/' } }));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(resolve4).mockResolvedValueOnce(['104.18.38.184']);
    expect(await webhookPost('https://receiver.example/callback', '{}', { 'Content-Type': 'application/json' })).toEqual({ status: 302, body: '' });
    expect(fetchMock).toHaveBeenCalledWith('https://receiver.example/callback', expect.objectContaining({
      method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' }, redirect: 'manual', signal: expect.any(AbortSignal),
    }));
    vi.mocked(resolve4).mockResolvedValueOnce(['127.0.0.1']);
    await expect(webhookPost('https://receiver.example/callback', '{}', {})).rejects.toThrow('not public');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns the response body and rejects responses over 64 KiB', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('{"challenge":"ok"}', { status: 200 }))
      .mockResolvedValueOnce(new Response('x'.repeat(64 * 1024 + 1), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(resolve4).mockResolvedValue(['8.8.8.8']);
    expect(await webhookPost('https://receiver.example/callback', '{}', {})).toEqual({ status: 200, body: '{"challenge":"ok"}' });
    await expect(webhookPost('https://receiver.example/callback', '{}', {})).rejects.toThrow('Callback response too large');
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
