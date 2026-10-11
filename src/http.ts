import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv } from './types';

export async function boundedBody(request: Request, max: number) {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new HTTPException(413, { message: 'Request body too large' });
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

export async function body<T extends z.ZodType>(c: Context<AppEnv>, schema: T): Promise<z.output<T>> {
  if (!c.req.header('Content-Type')?.toLowerCase().startsWith('application/json')) {
    throw new HTTPException(415, { message: 'Content-Type must be application/json' });
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(await boundedBody(c.req.raw, 128 * 1024))); }
  catch (error) {
    if (error instanceof HTTPException) throw error;
    throw new HTTPException(400, { message: 'Invalid JSON' });
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HTTPException(400, { message: z.prettifyError(parsed.error) });
  return parsed.data;
}

export function pagination(c: Context<AppEnv>) {
  const raw = c.req.query('limit') ?? '50';
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 100) throw new HTTPException(400, { message: 'limit must be 1..100' });
  return { limit: Number(raw), after: c.req.query('after') ?? '' };
}
