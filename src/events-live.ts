import { z } from 'zod';
import type { Env } from './types';
import { messageEventName, messageEventFilters } from './events';

const filterSchema = messageEventFilters.extend({ name: z.literal(messageEventName), principal_id: z.uuid() }).strict();
type Filter = z.infer<typeof filterSchema>;
const noticeSchema = z.object({
  project_id: z.uuid(), message_id: z.uuid(), timestamp: z.iso.datetime({ offset: true }),
  sender_role_id: z.uuid().nullable(), recipient_role_ids: z.array(z.union([z.uuid(), z.literal('ALL')])).min(1).max(20),
}).strict();
export type MessageNotice = z.infer<typeof noticeSchema>;

// Only reachable through the internal binding. No timers or SSE responses here:
// platform-held sockets and attachments survive instance hibernation.
export class EventsLive {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/notify' && request.method === 'POST') {
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > 4096) return new Response(null, { status: 413 });
      let input: unknown;
      try { input = JSON.parse(new TextDecoder().decode(bytes)); } catch { return new Response(null, { status: 400 }); }
      const parsed = noticeSchema.safeParse(input);
      if (!parsed.success) return new Response(null, { status: 400 });
      const notice = parsed.data;
      // Multiple listeners for the same role receive the same frame. Keep this
      // cache local to the invocation so no state needs restoring after sleep.
      const frames = new Map<string, string>();
      for (const socket of this.state.getWebSockets()) {
        const filter = socket.deserializeAttachment() as Filter;
        if (socket.readyState !== WebSocket.OPEN || filter.name !== messageEventName || filter.project_id !== notice.project_id ||
            filter.recipient_role_id === notice.sender_role_id ||
            (!notice.recipient_role_ids.includes('ALL') && !notice.recipient_role_ids.includes(filter.recipient_role_id))) continue;
        let frame = frames.get(filter.recipient_role_id);
        if (!frame) {
          const eventId = `evt_message_${notice.message_id}_${filter.recipient_role_id}`;
          const event = { eventId, name: messageEventName, timestamp: notice.timestamp, data: {
            project_id: notice.project_id, recipient_role_id: filter.recipient_role_id, message_count: 1,
            first_message_id: notice.message_id, last_message_id: notice.message_id,
            first_received_at: notice.timestamp, last_received_at: notice.timestamp,
          } };
          frame = `id: ${eventId}\nevent: ${messageEventName}\ndata: ${JSON.stringify(event)}\n\n`;
          frames.set(filter.recipient_role_id, frame);
        }
        try { socket.send(frame); }
        catch { this.webSocketError(socket); }
      }
      return new Response(null, { status: 204 });
    }
    if (url.pathname !== '/events' || request.method !== 'GET') return new Response(null, { status: 404 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response(null, { status: 426 });
    const parsed = filterSchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) return new Response(null, { status: 400 });
    const sockets = this.state.getWebSockets().filter(socket => socket.readyState === WebSocket.OPEN);
    if (sockets.length >= 256 || sockets.filter(socket => (socket.deserializeAttachment() as Filter).principal_id === parsed.data.principal_id).length >= 16) {
      return new Response(null, { status: 429, headers: { 'Retry-After': '30' } });
    }
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment(parsed.data);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(socket: WebSocket) { socket.close(1008, 'Receive-only connection'); }
  webSocketClose(socket: WebSocket, code: number, reason: string) {
    try { socket.close(code === 1005 || code === 1006 ? 1000 : code, reason); } catch { /* Already closed. */ }
  }
  webSocketError(socket: WebSocket) {
    try { socket.close(1011, 'Connection failed'); } catch { /* Already closed. */ }
  }
}

export function eventsLiveStub(env: Env, projectId: string) {
  return env.EVENTS_LIVE.get(env.EVENTS_LIVE.idFromName(projectId));
}

export async function notifyMessageEvent(env: Env, notice: MessageNotice) {
  try {
    const response = await eventsLiveStub(env, notice.project_id).fetch('https://events-live/notify', {
      method: 'POST', body: JSON.stringify(notice), signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) throw new Error('Notification failed');
  } catch {
    // The write already committed. REST catch-up reads recover missed hints.
    console.warn(JSON.stringify({ event: 'rest_event_notify_failed', message_id: notice.message_id }));
  }
}
