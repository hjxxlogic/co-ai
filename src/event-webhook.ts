import { resolve4 } from 'node:dns/promises';

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

export async function webhookPost(value: string, body: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const url = callbackUrl(value);
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  const addresses = await Promise.race([
    resolve4(url.hostname),
    new Promise<never>((_resolve, reject) => { dnsTimer = setTimeout(() => reject(new Error('Callback DNS timeout')), 10_000); }),
  ]).finally(() => clearTimeout(dnsTimer));
  if (!addresses.length || addresses.some((address) => !publicIpv4(address))) throw new Error('Callback address is not public');

  // Workers fetch checks the final destination, including after its own DNS lookup.
  const response = await fetch(url.href, {
    method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(10_000),
  });
  const reader = response.body?.getReader();
  if (!reader) return { status: response.status, body: '' };
  const decoder = new TextDecoder();
  let text = '', size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return { status: response.status, body: text + decoder.decode() };
      size += value.byteLength;
      if (size > 64 * 1024) throw new Error('Callback response too large');
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
