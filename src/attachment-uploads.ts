import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv } from './types';
import { body, boundedBody } from './http';
import { digest } from './security';
import { expiresIn, grantIdentity, oauthIdentity, oauthSecret } from './oauth-security';

const maxSize = 10 * 1024 * 1024;
const lifetimeSeconds = 600;
const uploadSchema = z.object({
  filename: z.string().min(1).max(200).regex(/^[^\x00-\x1f\x7f/\\]+$/),
  content_type: z.string().min(1).max(200).regex(/^[^\x00-\x1f\x7f]+$/).default('application/octet-stream'),
  size: z.number().int().min(0).max(maxSize).optional(),
}).strict();

// Mounted within the existing project route: its authentication, project
// isolation, OAuth write scope and key permissions run before issuing a link.
export const attachmentUploads = new Hono<AppEnv>();
attachmentUploads.post('/', async (c) => {
  const input = await body(c, uploadSchema);
  const principal = c.get('principal'), projectId = c.req.param('projectId')!;
  const oauth = await oauthIdentity(c, 'api');
  const user = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(principal.user_id).first<{ password_hash: string | null }>();
  const token = oauthSecret('coau_'), id = crypto.randomUUID(), expiresAt = expiresIn(lifetimeSeconds);
  // Expired capabilities do not need to be kept after their attachment exists.
  await c.env.DB.prepare('DELETE FROM attachment_uploads WHERE expires_at <= ?').bind(new Date().toISOString()).run();
  await c.env.DB.prepare('INSERT INTO attachment_uploads (token_hash, attachment_id, project_id, key_id, grant_id, password_hash, filename, content_type, expected_size, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(await digest(token), id, projectId, principal.id, oauth?.grantId ?? null, user!.password_hash, input.filename, input.content_type, input.size ?? null, expiresAt).run();
  return c.json({ data: {
    upload_url: new URL('/api/uploads/attachments/' + token, c.req.url).href,
    method: 'PUT', headers: { 'Content-Type': input.content_type },
    expires_at: expiresAt, max_size: maxSize, expected_size: input.size ?? null,
    attachment_id: id, filename: input.filename,
    instructions: 'PUT the complete raw file bytes to upload_url, without Authorization or Cookie. Do not send Base64, JSON or multipart. A successful upload returns 201 with attachment metadata. Keep the upload URL private; it expires in 10 minutes and can be used once.',
  } }, 201);
});

// The capability authorizes only one upload to its fixed project and filename.
// It cannot read data or authorize any other REST/MCP request.
export const uploadTransfer = new Hono<AppEnv>();
async function activeUpload(c: Context<AppEnv>, hash: string, claim: string | null = null) {
  const ticket = await c.env.DB.prepare(`SELECT t.*, k.user_id FROM attachment_uploads t
    JOIN api_keys k ON k.id = t.key_id JOIN users u ON u.id = k.user_id
    JOIN projects p ON p.id = t.project_id
    WHERE t.token_hash = ? AND t.expires_at > ? AND (t.claimed_by IS NULL OR t.claimed_by = ?)
    AND k.revoked_at IS NULL AND k.permission = 'write' AND u.disabled_at IS NULL
    AND u.password_hash IS t.password_hash AND p.owner_id = k.user_id
    AND (k.project_id IS NULL OR k.project_id = t.project_id)
    AND p.archived_at IS NULL`)
    .bind(hash, new Date().toISOString(), claim).first<{
      attachment_id: string; project_id: string; key_id: string; grant_id: string | null;
      user_id: string; filename: string; content_type: string; expected_size: number | null;
    }>();
  if (!ticket) throw new HTTPException(404, { message: 'Upload link expired, used, or no longer authorized' });
  if (ticket.grant_id) {
    const identity = await grantIdentity(c.env, ticket.grant_id);
    if (!identity?.principal || identity.principal.id !== ticket.key_id || !identity.scope.split(' ').some((scope) => ['write', 'manage'].includes(scope))) {
      throw new HTTPException(404, { message: 'Upload authorization is no longer active' });
    }
  }
  return ticket;
}

uploadTransfer.put('/:token', async (c) => {
  if (!/^coau_[a-f0-9]{64}$/.test(c.req.param('token'))) throw new HTTPException(404, { message: 'Upload link not available' });
  const hash = await digest(c.req.param('token'));
  const ticket = await activeUpload(c, hash);
  const contentType = c.req.header('Content-Type');
  if (contentType && contentType !== ticket.content_type) throw new HTTPException(415, { message: 'Use the Content-Type returned with the upload link' });
  // Claim before accepting the body: concurrent PUTs must not overwrite R2 or
  // produce duplicate metadata. Release the claim after a failed upload.
  const claim = oauthSecret('');
  const result = await c.env.DB.prepare('UPDATE attachment_uploads SET claimed_by = ? WHERE token_hash = ? AND claimed_by IS NULL AND expires_at > ?')
    .bind(claim, hash, new Date().toISOString()).run();
  if (!result.meta.changes) throw new HTTPException(409, { message: 'Upload link already in use or expired' });
  const objectKey = `${ticket.user_id}/${ticket.project_id}/${ticket.attachment_id}`;
  let stored = false;
  try {
    const bytes = await boundedBody(c.req.raw, maxSize);
    if (ticket.expected_size !== null && ticket.expected_size !== bytes.byteLength) throw new HTTPException(400, { message: 'Upload byte count does not match the declared size' });
    // A slow upload must not outlive its capability or a revoked grant.
    await activeUpload(c, hash, claim);
    const data = { id: ticket.attachment_id, filename: ticket.filename, content_type: ticket.content_type, size: bytes.byteLength, created_by: ticket.key_id, created_at: new Date().toISOString() };
    await c.env.FILES.put(objectKey, bytes, { httpMetadata: { contentType: ticket.content_type } });
    stored = true;
    await c.env.DB.prepare('INSERT INTO attachments (id, project_id, filename, object_key, content_type, size, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(data.id, ticket.project_id, data.filename, objectKey, data.content_type, data.size, data.created_by, data.created_at).run();
    return c.json({ data }, 201);
  } catch (error) {
    // Keep the claim if cleanup fails, to avoid another writer racing an
    // uncertain object. The client can request a fresh link in that case.
    if (stored) await c.env.FILES.delete(objectKey);
    await c.env.DB.prepare('UPDATE attachment_uploads SET claimed_by = NULL WHERE token_hash = ? AND claimed_by = ?')
      .bind(hash, claim).run();
    throw error;
  }
});
