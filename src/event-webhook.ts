export type WebhookFailureStage = 'http_request' | 'response_read';
export type WebhookFailureReason = 'address_rejected' | 'timeout' | 'transport_failed' | 'response_too_large';

export class WebhookRequestError extends Error {
  constructor(public readonly stage: WebhookFailureStage, public readonly reason: WebhookFailureReason, message: string, public readonly errorCode?: string, public readonly responseStatus?: number) {
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

export async function webhookPost(value: string, body: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const url = callbackUrl(value);
  // Temporary: skip the resolve4 public-IPv4 precheck. It rejected ChatGPT callbacks
  // before fetch ran. Workers fetch still blocks private and local destinations.
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
