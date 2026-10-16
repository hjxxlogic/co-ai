import { resolve4 } from 'node:dns/promises';

export type WebhookFailureStage = 'dns_lookup' | 'address_validation' | 'http_request' | 'response_read';
export type WebhookFailureReason = 'dns_failed' | 'address_rejected' | 'timeout' | 'transport_failed' | 'response_too_large';
type AddressDiagnostics = { addressCheck: 'empty_result' | 'non_public_address'; resolvedAddresses: string[]; addressCount: number };

export class WebhookRequestError extends Error {
  constructor(public readonly stage: WebhookFailureStage, public readonly reason: WebhookFailureReason, message: string, public readonly errorCode?: string, public readonly responseStatus?: number, public readonly addressDiagnostics?: AddressDiagnostics) {
    super(message);
    this.name = 'WebhookRequestError';
  }
}

function failureCode(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && /^(ENOTFOUND|ENODATA|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ERR_TLS_CERT_ALTNAME_INVALID)$/.test(code) ? code : undefined;
}

function isTimeout(error: unknown) {
  return failureCode(error) === 'ETIMEDOUT' || error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError' || /timeout|timed out/i.test(error.message));
}

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
  let addresses: string[];
  try {
    addresses = await Promise.race([
      resolve4(url.hostname),
      new Promise<never>((_resolve, reject) => { dnsTimer = setTimeout(() => reject(new Error('Callback DNS timeout')), 10_000); }),
    ]);
  } catch (error) {
    throw new WebhookRequestError('dns_lookup', isTimeout(error) ? 'timeout' : 'dns_failed', 'Callback DNS lookup failed', failureCode(error));
  } finally { clearTimeout(dnsTimer); }
  if (!addresses.length || addresses.some((address) => !publicIpv4(address))) {
    throw new WebhookRequestError('address_validation', 'address_rejected', 'Callback address is not public', undefined, undefined, {
      addressCheck: addresses.length ? 'non_public_address' : 'empty_result',
      resolvedAddresses: addresses.slice(0, 16), addressCount: addresses.length,
    });
  }

  // Workers fetch checks the final destination, including after its own DNS lookup.
  let response: Response;
  try {
    response = await fetch(url.href, {
      method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    const reason = isTimeout(error) ? 'timeout'
      : error instanceof Error && /address|private|not public/i.test(error.message) ? 'address_rejected' : 'transport_failed';
    throw new WebhookRequestError('http_request', reason, 'Callback HTTP request failed', failureCode(error));
  }
  const reader = response.body?.getReader();
  if (!reader) return { status: response.status, body: '' };
  const decoder = new TextDecoder();
  let text = '', size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return { status: response.status, body: text + decoder.decode() };
      size += value.byteLength;
      if (size > 64 * 1024) throw new WebhookRequestError('response_read', 'response_too_large', 'Callback response too large', undefined, response.status);
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    if (error instanceof WebhookRequestError) throw error;
    throw new WebhookRequestError('response_read', isTimeout(error) ? 'timeout' : 'transport_failed', 'Callback response read failed', failureCode(error), response.status);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
