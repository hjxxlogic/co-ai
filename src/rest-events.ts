import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv } from './types';
import { messageEvent, messageEventFilters, messageEventName } from './events';
import { eventsLiveStub } from './events-live';
import { eventStream } from './events-stream';

export const restEvents = new Hono<AppEnv>();
const querySchema = messageEventFilters.extend({ name: z.literal(messageEventName) }).strict();
restEvents.get('/', (c) => c.json({ data: [{ ...messageEvent, delivery: ['sse'],
  description: 'Immediate hints for newly created messages addressed to an active project role, including ALL broadcasts, excluding the sending role itself. No replay; read message data with REST.',
}] }));
restEvents.get('/stream', async (c) => {
  const params = new URL(c.req.url).searchParams;
  const parsed = querySchema.safeParse(Object.fromEntries(params));
  if (!parsed.success || [...params.keys()].some(key => params.getAll(key).length !== 1)) {
    throw new HTTPException(400, { message: 'Expected name, project_id and recipient_role_id without duplicate or unknown parameters' });
  }
  if (c.req.header('Last-Event-ID') !== undefined) throw new HTTPException(400, { message: 'Event replay is not supported; reconnect, wait for ready, then query REST changes' });
  const principal = c.get('principal');
  const { project_id: projectId, recipient_role_id: roleId } = parsed.data;
  const accessible = await c.env.DB.prepare(`SELECT r.id FROM roles r JOIN projects p ON p.id = r.project_id
    WHERE r.id = ? AND p.id = ? AND p.owner_id = ? AND p.archived_at IS NULL AND r.archived_at IS NULL
    AND (? IS NULL OR p.id = ?)`).bind(roleId, projectId, principal.user_id, principal.project_id, principal.project_id).first();
  if (!accessible) throw new HTTPException(404, { message: 'Project or recipient role unavailable' });
  const url = new URL('https://events-live/events');
  for (const [key, value] of Object.entries({ ...parsed.data, principal_id: principal.user_id })) url.searchParams.set(key, value);
  const response = await eventsLiveStub(c.env, projectId).fetch(url, { headers: { Upgrade: 'websocket' } }).catch(() => {
    throw new HTTPException(503, { message: 'Event service unavailable' });
  });
  if (response.status === 429) {
    c.header('Retry-After', '30');
    throw new HTTPException(429, { message: 'Too many event connections' });
  }
  if (response.status !== 101 || !response.webSocket) throw new HTTPException(503, { message: 'Event service unavailable' });
  return eventStream(response.webSocket, c.req.raw.signal);
});
