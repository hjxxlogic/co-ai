import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { resolve4 } from 'node:dns/promises';
import { connect } from 'node:tls';
import { createHmac } from 'node:crypto';
import { callbackUrl, publicIpv4, webhookPost } from '../src/event-webhook';
import { signedHeaders } from '../src/mcp-events';

vi.mock('node:dns/promises', () => ({ resolve4: vi.fn() }));
vi.mock('node:tls', () => ({ connect: vi.fn() }));
afterEach(() => { vi.clearAllMocks(); });

describe('event webhook security', () => {
  it('blocks local, private, mapped, special-use and credential-bearing destinations', async () => {
    for (const url of ['http://example.com', 'https://localhost', 'https://127.0.0.1', 'https://[::ffff:127.0.0.1]', 'https://user:pass@example.com', 'https://example.com:444', 'https://example.com/#fragment']) expect(() => callbackUrl(url)).toThrow();
    for (const ip of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255']) expect(publicIpv4(ip), ip).toBe(false);
    vi.mocked(resolve4).mockResolvedValueOnce(['8.8.8.8', '10.0.0.1']);
    await expect(webhookPost('https://receiver.example/callback', '{}', {})).rejects.toThrow('not public');
    expect(connect).not.toHaveBeenCalled();
  });

  it('pins the validated address, verifies the hostname and refuses redirect delivery', async () => {
    const socket = new EventEmitter() as EventEmitter & { write: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
    socket.write = vi.fn(() => {
      queueMicrotask(() => { socket.emit('data', Buffer.from('HTTP/1.1 302 Found\r\nLocation: https://localhost/\r\nContent-Length: 0\r\n\r\n')); socket.emit('end'); });
    });
    socket.destroy = vi.fn(() => { socket.emit('close'); return socket; });
    vi.mocked(resolve4).mockResolvedValueOnce(['8.8.8.8']);
    vi.mocked(connect).mockImplementationOnce(() => { queueMicrotask(() => socket.emit('secureConnect')); return socket as unknown as ReturnType<typeof connect>; });
    expect(await webhookPost('https://receiver.example/callback', '{}', { 'Content-Type': 'application/json' })).toEqual({ status: 302, body: '' });
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ host: '8.8.8.8', servername: 'receiver.example', rejectUnauthorized: true }));
    expect(socket.write.mock.calls[0][0]).toContain('Host: receiver.example');
    expect(connect).toHaveBeenCalledTimes(1);
    vi.mocked(resolve4).mockResolvedValueOnce(['127.0.0.1']);
    await expect(webhookPost('https://receiver.example/callback', '{}', {})).rejects.toThrow('not public');
    expect(connect).toHaveBeenCalledTimes(1);
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
