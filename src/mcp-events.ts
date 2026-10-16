import type { Context } from 'hono';
import { z } from 'zod';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { AppEnv, Env, Principal } from './types';
import { bearer, digest } from './security';
import { sessionPrincipal } from './web-auth';
import { grantIdentity, requireOAuthScope, type OAuthIdentity } from './oauth-security';
import { callbackUrl, webhookPost, WebhookRequestError } from './event-webhook';
import { timingSafeEqual } from 'node:crypto';

const eventName = 'role.messages.received';
const lifetimeMs = 24 * 60 * 60 * 1000;
const cooldownMs = 5 * 60 * 1000;
const filters = z.object({ project_id: z.uuid(), recipient_role_id: z.uuid() }).strict();
const delivery = z.object({ mode: z.literal('webhook'), url: z.string().max(2048), secret: z.string().max(100).optional() }).strict();
const subscription = z.object({ name: z.literal(eventName), arguments: filters, delivery, cursor: z.null().optional(), ttlMs: z.number().int().positive().nullable().optional(), _meta: z.record(z.string(), z.unknown()).optional() }).strict();
type Subscription = {
  id: string; owner: string; key_id: string; grant_id: string | null; project_id: string; role_id: string;
  callback_url: string; secret: string; previous_secret: string | null; rotation_until: number;
  verified_until: number; expires_at: number; event_body: string | null; pending_count: number;
  attempts: number; lease: string; next_attempt: number;
};
const invalid = (message: string) => new McpError(ErrorCode.InvalidParams, message);

export const messageEvent = {
  name: eventName,
  description: 'New messages addressed to an active project role, including ALL broadcasts. Messages are coalesced into a summary; at most one delivery per subscription every five minutes. Read messages using the item tools.',
  delivery: ['webhook'],
  inputSchema: { type: 'object', properties: { project_id: { type: 'string', format: 'uuid' }, recipient_role_id: { type: 'string', format: 'uuid' } }, required: ['project_id', 'recipient_role_id'], additionalProperties: false },
  payloadSchema: { type: 'object', properties: {
    project_id: { type: 'string' }, recipient_role_id: { type: 'string' }, message_count: { type: 'integer', minimum: 1 },
    first_message_id: { type: 'string' }, last_message_id: { type: 'string' },
    first_received_at: { type: 'string' }, last_received_at: { type: 'string' },
  }, required: ['project_id', 'recipient_role_id', 'message_count', 'first_message_id', 'last_message_id', 'first_received_at', 'last_received_at'], additionalProperties: false },
};

async function eventPrincipal(c: Context<AppEnv>, oauth: OAuthIdentity | null): Promise<Principal | null> {
  if (oauth) {
    if (!oauth.principal) return null;
    requireOAuthScope(c, oauth, 'read');
    return oauth.principal;
  }
  if (!c.req.header('Authorization')) return sessionPrincipal(c);
  const hash = await digest(bearer(c));
  if (c.env.ADMIN_TOKEN?.length >= 32 && hash === await digest(c.env.ADMIN_TOKEN)) return null;
  return c.env.DB.prepare("SELECT k.id, k.user_id, k.project_id, k.permission FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = ? AND k.kind = 'api' AND k.revoked_at IS NULL AND u.disabled_at IS NULL")
    .bind(hash).first<Principal>();
}

function secretBytes(secret: string) {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw invalid('Invalid webhook signing secret');
  try {
    const bytes = Uint8Array.from(atob(secret.slice(6)), (s) => s.charCodeAt(0));
    if (bytes.length < 24 || bytes.length > 64 || btoa(String.fromCharCode(...bytes)) !== secret.slice(6)) throw new Error();
    return bytes;
  } catch { throw invalid('Signing secret must contain 24–64 bytes in canonical Base64'); }
}

export async function signedHeaders(row: Pick<Subscription, 'id' | 'secret' | 'previous_secret' | 'rotation_until'>, eventId: string, body: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const secrets = [row.secret, ...(row.previous_secret && row.rotation_until > Date.now() ? [row.previous_secret] : [])];
  const signatures = await Promise.all(secrets.map(async (secret) => {
    const key = await crypto.subtle.importKey('raw', secretBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${eventId}.${timestamp}.${body}`)));
    return `v1,${btoa(String.fromCharCode(...bytes))}`;
  }));
  return { 'Content-Type': 'application/json', 'webhook-id': eventId, 'webhook-timestamp': timestamp, 'webhook-signature': signatures.join(' '), 'X-MCP-Subscription-Id': row.id };
}

export async function handleEventMethod(c: Context<AppEnv>, oauth: OAuthIdentity | null, method: string, params: unknown) {
  const principal = await eventPrincipal(c, oauth);
  if (method === 'events/list') {
    const parsed = z.object({ cursor: z.null().optional(), _meta: z.record(z.string(), z.unknown()).optional() }).strict().safeParse(params ?? {});
    if (!parsed.success) throw invalid('Event catalog has no pagination cursor');
    return { events: principal ? [messageEvent] : [] };
  }
  if (!principal) throw new McpError(-32024, 'A user or project identity with read access is required');
  const parsed = subscription.safeParse(params);
  if (!parsed.success) throw invalid('Invalid event subscription arguments');
  const input = parsed.data;
  let url: string;
  try { url = callbackUrl(input.delivery.url).href; } catch { throw invalid('Callback must be a public HTTPS hostname on port 443'); }
  const owner = oauth ? `grant:${oauth.grantId}` : `key:${principal.id}`;
  const id = 'sub_' + await digest(JSON.stringify([owner, url, eventName, input.arguments.project_id, input.arguments.recipient_role_id]));
  if (method === 'events/unsubscribe') {
    await c.env.DB.prepare('DELETE FROM mcp_event_subscriptions WHERE id = ? AND owner = ?').bind(id, owner).run();
    return {};
  }
  const { project_id: projectId, recipient_role_id: roleId } = input.arguments;
  const accessible = await c.env.DB.prepare('SELECT r.id FROM roles r JOIN projects p ON p.id = r.project_id WHERE r.id = ? AND p.id = ? AND p.owner_id = ? AND p.archived_at IS NULL AND r.archived_at IS NULL AND (? IS NULL OR p.id = ?)')
    .bind(roleId, projectId, principal.user_id, principal.project_id, principal.project_id).first();
  if (!accessible) throw new McpError(-32024, 'Project or recipient role unavailable');
  const secret = input.delivery.secret;
  if (!secret) throw invalid('Webhook signing secret is required');
  secretBytes(secret);
  const now = Date.now();
  await c.env.DB.prepare('DELETE FROM mcp_event_subscriptions WHERE id = ? AND expires_at <= ?').bind(id, now).run();
  const existing = await c.env.DB.prepare('SELECT * FROM mcp_event_subscriptions WHERE id = ?').bind(id).first<Subscription>();
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM mcp_event_subscriptions WHERE owner = ? AND expires_at > ?').bind(owner, now).first<{ n: number }>();
  if (!existing && (count?.n ?? 0) >= 20) throw new McpError(-32026, 'At most 20 active subscriptions per identity');
  if (!existing || existing.verified_until <= now || existing.secret !== secret) {
    const challenge = crypto.randomUUID();
    const body = JSON.stringify({ type: 'verification', challenge });
    let reason = 'challenge_failed';
    let stage = 'callback_response';
    let responseStatus: number | undefined;
    try {
      const response = await webhookPost(url, body, await signedHeaders({ id, secret, previous_secret: null, rotation_until: 0 }, 'msg_verification_' + crypto.randomUUID(), body));
      responseStatus = response.status;
      if (response.status < 200 || response.status >= 300) { reason = 'http_error'; throw new Error(); }
      let echoed: { challenge?: unknown };
      try { echoed = JSON.parse(response.body) as { challenge?: unknown }; }
      catch { reason = 'invalid_response'; throw new Error(); }
      if (typeof echoed?.challenge !== 'string' || !timingSafeEqual(new TextEncoder().encode(await digest(echoed.challenge)), new TextEncoder().encode(await digest(challenge)))) throw new Error();
    } catch (error) {
      if (error instanceof WebhookRequestError) { reason = error.reason; stage = error.stage; responseStatus = error.responseStatus; }
      const details = { reason, stage, ...(responseStatus === undefined ? {} : { responseStatus }) };
      // Log selected request fields only; callback paths, challenges, and signing keys are private.
      console.warn(JSON.stringify({ event: 'mcp_event_callback_verification_failed', ...details,
        request: { name: input.name, projectId, recipientRoleId: roleId, callbackHost: new URL(url).hostname, deliveryMode: input.delivery.mode, requestedTtlMs: input.ttlMs ?? null },
        ...(error instanceof WebhookRequestError && error.errorCode ? { errorCode: error.errorCode } : {}),
      }));
      throw new McpError(-32015, 'Callback verification failed', details);
    }
  }
  const expiresAt = now + Math.max(60_000, Math.min(input.ttlMs ?? lifetimeMs, lifetimeMs));
  const password = await c.env.DB.prepare("SELECT u.password_hash FROM users u JOIN api_keys k ON k.user_id = u.id WHERE k.id = ? AND k.kind != 'api'").bind(principal.id).first<{ password_hash: string | null }>();
  await c.env.DB.prepare(`INSERT INTO mcp_event_subscriptions (id, owner, key_id, grant_id, password_hash, project_id, role_id, callback_url, secret, verified_until, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
    previous_secret = CASE WHEN secret != excluded.secret THEN secret ELSE previous_secret END,
    rotation_until = CASE WHEN secret != excluded.secret THEN ? ELSE rotation_until END,
    secret = excluded.secret, verified_until = excluded.verified_until, expires_at = excluded.expires_at`)
    .bind(id, owner, principal.id, oauth?.grantId ?? null, password?.password_hash ?? null, projectId, roleId, url, secret, existing?.secret === secret && existing.verified_until > now ? existing.verified_until : now + 300_000, expiresAt, now + 300_000).run();
  return { id, refreshBefore: new Date(expiresAt).toISOString(), cursor: null, truncated: false };
}

async function stillAuthorized(env: Env, row: Subscription) {
  const key = await env.DB.prepare(`SELECT k.id FROM api_keys k JOIN users u ON u.id = k.user_id
    JOIN projects p ON p.id = ? AND p.owner_id = k.user_id JOIN roles r ON r.id = ? AND r.project_id = p.id
    WHERE k.id = ? AND k.revoked_at IS NULL AND u.disabled_at IS NULL AND p.archived_at IS NULL AND r.archived_at IS NULL
    AND (k.project_id IS NULL OR k.project_id = p.id)
    AND (k.kind = 'api' OR u.password_hash = (SELECT password_hash FROM mcp_event_subscriptions WHERE id = ?))`).bind(row.project_id, row.role_id, row.key_id, row.id).first();
  if (!key) return false;
  if (row.grant_id) {
    const grant = await grantIdentity(env, row.grant_id);
    if (!grant?.principal || grant.principal.id !== row.key_id || !grant.scope.split(' ').some((scope) => ['read', 'write', 'manage'].includes(scope))) return false;
  }
  return true;
}

export async function deliverMessageEvents(env: Env) {
  const now = Date.now();
  await env.DB.prepare('DELETE FROM mcp_event_subscriptions WHERE expires_at <= ?').bind(now).run();
  const { results } = await env.DB.prepare('SELECT id FROM mcp_event_subscriptions WHERE next_attempt <= ? AND lease_until <= ? AND (pending_count > 0 OR event_body IS NOT NULL) ORDER BY next_attempt LIMIT 50').bind(now, now).all<{ id: string }>();
  // Bound concurrent connections, and isolate failures between subscriptions.
  for (let offset = 0; offset < results.length; offset += 5) {
    await Promise.all(results.slice(offset, offset + 5).map(async ({ id }) => {
      const lease = crypto.randomUUID(), eventId = 'evt_' + crypto.randomUUID();
      const row = await env.DB.prepare(`UPDATE mcp_event_subscriptions SET lease = ?, lease_until = ?, next_attempt = ?, attempts = attempts + 1,
        event_body = COALESCE(event_body, json_object('eventId', ?, 'name', ?, 'timestamp', first_received_at, 'cursor', NULL,
          'data', json_object('project_id', project_id, 'recipient_role_id', role_id, 'message_count', pending_count,
            'first_message_id', first_message_id, 'last_message_id', last_message_id, 'first_received_at', first_received_at, 'last_received_at', last_received_at))),
        pending_count = CASE WHEN event_body IS NULL THEN 0 ELSE pending_count END
        WHERE id = ? AND next_attempt <= ? AND lease_until <= ? AND expires_at > ? AND (pending_count > 0 OR event_body IS NOT NULL) RETURNING *`)
        .bind(lease, Date.now() + 120_000, Date.now() + cooldownMs, eventId, eventName, id, Date.now(), Date.now(), Date.now()).first<Subscription>();
      if (!row) return;
      if (!await stillAuthorized(env, row)) {
        await env.DB.prepare('DELETE FROM mcp_event_subscriptions WHERE id = ? AND lease = ?').bind(id, lease).run();
        return;
      }
      let status = 0;
      try {
        const body = row.event_body!;
        status = (await webhookPost(row.callback_url, body, await signedHeaders(row, JSON.parse(body).eventId, body))).status;
      } catch { /* Retry network failures without logging callback secrets. */ }
      if (status === 410) {
        await env.DB.prepare('DELETE FROM mcp_event_subscriptions WHERE id = ? AND lease = ?').bind(id, lease).run();
        return;
      }
      const retry = (status === 0 || status === 408 || status === 429 || status >= 500) && row.attempts < 4;
      await env.DB.prepare(`UPDATE mcp_event_subscriptions SET event_body = CASE WHEN ? THEN event_body ELSE NULL END,
        attempts = CASE WHEN ? THEN attempts ELSE 0 END, next_attempt = ?, lease = NULL, lease_until = 0
        WHERE id = ? AND lease = ?`).bind(Number(retry), Number(retry), Date.now() + cooldownMs * (retry ? 2 ** (row.attempts - 1) : 1), id, lease).run();
    }));
  }
}
