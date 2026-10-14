import { resolve4 } from 'node:dns/promises';
import { connect } from 'node:tls';
import { Buffer } from 'node:buffer';

export function callbackUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') || !/^[a-z0-9.-]+$/i.test(url.hostname) || !url.hostname.includes('.') || /^\d+\./.test(url.hostname)) throw new Error('Invalid callback URL');
  return url;
}

export function publicIpv4(address: string) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = parts;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 2 && c === 0))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}

// Resolve on every connection and pin the validated IP. TLS still verifies
// the callback hostname. A plain fetch after DNS validation could re-resolve it.
export async function webhookPost(value: string, body: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const url = callbackUrl(value);
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  const addresses = await Promise.race([
    resolve4(url.hostname),
    new Promise<never>((_resolve, reject) => { dnsTimer = setTimeout(() => reject(new Error('Callback DNS timeout')), 10_000); }),
  ]).finally(() => clearTimeout(dnsTimer));
  if (!addresses.length || addresses.some((address) => !publicIpv4(address))) throw new Error('Callback address is not public');
  return new Promise((resolve, reject) => {
    const socket = connect({ host: addresses[0], port: 443, servername: url.hostname, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => socket.destroy(new Error('Callback timeout')), 10_000);
    socket.on('error', reject);
    socket.on('close', () => { clearTimeout(timer); reject(new Error('Callback connection closed')); });
    socket.on('secureConnect', () => {
      const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
      socket.write(`POST ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.hostname}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n${lines.join('\r\n')}\r\n\r\n${body}`);
    });
    socket.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) socket.destroy(new Error('Callback response too large'));
      else chunks.push(chunk);
    });
    socket.on('end', () => {
      try {
        const bytes = Buffer.concat(chunks), boundary = bytes.indexOf('\r\n\r\n');
        if (boundary < 0) throw new Error('Invalid callback response');
        const head = bytes.subarray(0, boundary).toString();
        const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1]);
        if (!status) throw new Error('Invalid callback status');
        let payload = bytes.subarray(boundary + 4);
        if (/\r\ntransfer-encoding:\s*chunked\s*(?:\r\n|$)/i.test(head)) {
          const decoded: Buffer[] = [];
          let offset = 0;
          while (true) {
            const end = payload.indexOf('\r\n', offset);
            if (end < 0) throw new Error('Invalid chunk');
            const line = payload.subarray(offset, end).toString().split(';')[0];
            if (!/^[\da-f]+$/i.test(line)) throw new Error('Invalid chunk');
            const length = parseInt(line, 16);
            if (!length) break;
            offset = end + 2;
            if (offset + length + 2 > payload.length) throw new Error('Truncated chunk');
            decoded.push(payload.subarray(offset, offset + length));
            offset += length + 2;
          }
          payload = Buffer.concat(decoded);
        }
        resolve({ status, body: payload.toString() });
      } catch (error) { reject(error); }
      finally { socket.destroy(); }
    });
    // Redirects are returned as failures; there is no second connection.
  });
}
