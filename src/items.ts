import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv } from './types';
import { body, pagination } from './http';
import { digest } from './security';
import { activeRole } from './roles';

export const itemsApi = new Hono<AppEnv>();
const kind = z.enum(['note', 'task', 'decision', 'message']);
const status = z.enum(['open', 'in_progress', 'done', 'archived']);
const tag = z.string().trim().min(1).max(50).regex(/^[^\x00-\x1f\x7f]+$/, 'TAG cannot contain control characters').transform((s) => s.normalize('NFC').toLowerCase());
const tags = z.array(tag).max(20).transform((values) => [...new Set(values)]);
const fields = z.object({ title: z.string().trim().min(1).max(200), content: z.string().max(50000), kind, status, role_id: z.uuid().nullable(), tags }).strict();
const createSchema = fields.extend({ content: fields.shape.content.default(''), kind: kind.default('note'), status: status.default('open'), role_id: fields.shape.role_id.default(null), tags: tags.default([]) });
const version = z.number().int().positive();
const selectItem = 'SELECT i.*, r.name AS role_name FROM items i LEFT JOIN roles r ON r.id = i.role_id AND r.project_id = i.project_id';
type Row = Record<string, unknown> & { id: string; created_at: string; tags: string };
const serialize = (row: Row) => ({ ...row, tags: JSON.parse(row.tags) as string[] });
const timestamp = z.iso.datetime({ offset: true });

function parseTime(value: string | undefined, field: string) {
  if (value === undefined) return null;
  if (!timestamp.safeParse(value).success || !Number.isFinite(Date.parse(value))) throw new HTTPException(400, { message: `${field} must be an ISO 8601 timestamp with timezone` });
  return new Date(value).toISOString();
}
function positiveInteger(value: string | undefined, field: string, max: number) {
  if (value === undefined) return null;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) throw new HTTPException(400, { message: `${field} must be 1..${max}` });
  return Number(value);
}
const cursorSchema = z.object({ v: z.literal(1), fingerprint: z.string(), snapshot: timestamp, id: z.uuid(), time: timestamp, seen: z.number().int().min(0) }).strict();
type Cursor = z.infer<typeof cursorSchema>;
function decodeCursor(value: string): Cursor {
  try {
    if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    return cursorSchema.parse(JSON.parse(atob(value.replace(/-/g, '+').replace(/_/g, '/'))));
  } catch { throw new HTTPException(400, { message: 'Invalid cursor' }); }
}
const encodeCursor = (cursor: Cursor) => btoa(JSON.stringify(cursor)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

itemsApi.get('/', async (c) => {
  const { limit, after } = pagination(c);
  const filterStatus = c.req.query('status'), filterKind = c.req.query('kind');
  if (filterStatus !== undefined && !status.safeParse(filterStatus).success) throw new HTTPException(400, { message: 'Invalid status' });
  if (filterKind !== undefined && !kind.safeParse(filterKind).success) throw new HTTPException(400, { message: 'Invalid kind' });
  const deleted = c.req.query('include_deleted') ?? 'false';
  if (!['true', 'false'].includes(deleted)) throw new HTTPException(400, { message: 'include_deleted must be true or false' });
  const roleId = c.req.query('role_id');
  if (roleId !== undefined && roleId !== 'none' && !z.uuid().safeParse(roleId).success) throw new HTTPException(400, { message: 'role_id must be a role ID or none' });
  const parsedTags = tags.safeParse(c.req.queries('tag') ?? []);
  if (!parsedTags.success) throw new HTTPException(400, { message: 'Invalid TAG filter (up to 20 TAGs, 1..50 characters each)' });
  const filterTags = parsedTags.data.sort();
  const tagMode = c.req.query('tag_mode') ?? 'all';
  if (!['all', 'any'].includes(tagMode)) throw new HTTPException(400, { message: 'tag_mode must be all or any' });
  const from = parseTime(c.req.query('from'), 'from'), to = parseTime(c.req.query('to'), 'to');
  if (from && to && from > to) throw new HTTPException(400, { message: 'from must not be after to' });
  const q = (c.req.query('q') ?? '').trim();
  if (q.length > 200) throw new HTTPException(400, { message: 'q must be at most 200 characters' });
  const maxItems = positiveInteger(c.req.query('max_items'), 'max_items', 1000);
  const order = c.req.query('order') ?? (maxItems ? 'newest' : 'id');
  if (!['id', 'newest', 'oldest'].includes(order)) throw new HTTPException(400, { message: 'order must be id, newest or oldest' });
  const projectId = c.req.param('projectId');
  const fingerprint = await digest(JSON.stringify({ projectId, filterStatus, filterKind, deleted, roleId, filterTags, tagMode, from, to, q, maxItems, order }));
  let cursor: Cursor | null = null, legacyId = '';
  if (after) {
    if (order === 'id' && !maxItems && z.uuid().safeParse(after).success) legacyId = after;
    else {
      cursor = decodeCursor(after);
      if (cursor.fingerprint !== fingerprint || (maxItems && cursor.seen >= maxItems)) throw new HTTPException(400, { message: 'Cursor does not match these filters or is exhausted' });
    }
  }
  const snapshot = cursor?.snapshot ?? new Date().toISOString();
  const where = ['i.project_id = ?', 'i.created_at <= ?'];
  const bindings: (string | number)[] = [projectId!, snapshot];
  if (deleted === 'false') where.push('i.deleted_at IS NULL');
  if (filterStatus !== undefined) { where.push('i.status = ?'); bindings.push(filterStatus); }
  if (filterKind !== undefined) { where.push('i.kind = ?'); bindings.push(filterKind); }
  if (roleId === 'none') where.push('i.role_id IS NULL');
  else if (roleId) { where.push('i.role_id = ?'); bindings.push(roleId); }
  if (from) { where.push('i.created_at >= ?'); bindings.push(from); }
  if (to) { where.push('i.created_at <= ?'); bindings.push(to); }
  if (q) { where.push('(instr(lower(i.title), lower(?)) > 0 OR instr(lower(i.content), lower(?)) > 0)'); bindings.push(q, q); }
  if (filterTags.length && tagMode === 'any') {
    where.push(`EXISTS (SELECT 1 FROM json_each(i.tags) t WHERE t.value IN (${filterTags.map(() => '?').join(',')}))`);
    bindings.push(...filterTags);
  } else {
    for (const value of filterTags) { where.push('EXISTS (SELECT 1 FROM json_each(i.tags) t WHERE t.value = ?)'); bindings.push(value); }
  }
  const count = await c.env.DB.prepare(`SELECT COUNT(*) AS total FROM items i WHERE ${where.join(' AND ')}`).bind(...bindings).first<{ total: number }>();
  if (legacyId || (cursor && order === 'id')) { where.push('i.id > ?'); bindings.push(legacyId || cursor!.id); }
  else if (cursor) {
    const comparison = order === 'newest' ? '<' : '>';
    where.push(`(i.created_at ${comparison} ? OR (i.created_at = ? AND i.id ${comparison} ?))`);
    bindings.push(cursor.time, cursor.time, cursor.id);
  }
  const seen = cursor?.seen ?? 0;
  const pageSize = Math.min(limit, maxItems ? maxItems - seen : limit);
  const sort = order === 'id' ? 'i.id ASC' : order === 'newest' ? 'i.created_at DESC, i.id DESC' : 'i.created_at ASC, i.id ASC';
  const { results } = await c.env.DB.prepare(`${selectItem} WHERE ${where.join(' AND ')} ORDER BY ${sort} LIMIT ?`).bind(...bindings, pageSize + 1).all<Row>();
  const data = results.slice(0, pageSize).map(serialize), last = data.at(-1);
  const next = results.length > pageSize && (!maxItems || seen + data.length < maxItems) && last
    ? order === 'id' && !maxItems ? last.id : encodeCursor({ v: 1, fingerprint, snapshot, id: last.id, time: last.created_at, seen: seen + data.length })
    : null;
  return c.json({ data, next_cursor: next, total_count: count?.total ?? 0, max_items: maxItems });
});

itemsApi.post('/', async (c) => {
  const input = await body(c, createSchema);
  const role = await activeRole(c, input.role_id);
  const id = crypto.randomUUID(), time = new Date().toISOString(), keyId = c.get('principal').id;
  const row = await c.env.DB.prepare('INSERT INTO items (id, project_id, title, content, kind, status, role_id, tags, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *')
    .bind(id, c.req.param('projectId'), input.title, input.content, input.kind, input.status, input.role_id, JSON.stringify(input.tags), keyId, keyId, time, time).first<Row>();
  return c.json({ data: { ...serialize(row!), role_name: role?.name ?? null } }, 201);
});
itemsApi.get('/:itemId', async (c) => {
  const row = await c.env.DB.prepare(`${selectItem} WHERE i.id = ? AND i.project_id = ? AND i.deleted_at IS NULL`).bind(c.req.param('itemId'), c.req.param('projectId')).first<Row>();
  if (!row) throw new HTTPException(404, { message: 'Item not found' });
  return c.json({ data: serialize(row) });
});
itemsApi.patch('/:itemId', async (c) => {
  const input = await body(c, fields.partial().extend({ version }).refine((v) => Object.keys(v).length > 1, 'At least one changed field is required'));
  if (input.role_id !== undefined) await activeRole(c, input.role_id);
  const row = await c.env.DB.prepare('UPDATE items SET title = COALESCE(?, title), content = COALESCE(?, content), kind = COALESCE(?, kind), status = COALESCE(?, status), role_id = CASE WHEN ? = 1 THEN ? ELSE role_id END, tags = COALESCE(?, tags), version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND project_id = ? AND version = ? AND deleted_at IS NULL RETURNING *')
    .bind(input.title ?? null, input.content ?? null, input.kind ?? null, input.status ?? null, Number(input.role_id !== undefined), input.role_id ?? null, input.tags === undefined ? null : JSON.stringify(input.tags), c.get('principal').id, new Date().toISOString(), c.req.param('itemId'), c.req.param('projectId'), input.version).first<Row>();
  if (!row) await conflictOrMissing(c);
  const role = row!.role_id ? await c.env.DB.prepare('SELECT name FROM roles WHERE id = ? AND project_id = ?').bind(row!.role_id, c.req.param('projectId')).first<{ name: string }>() : null;
  return c.json({ data: { ...serialize(row!), role_name: role?.name ?? null } });
});
async function conflictOrMissing(c: Context<AppEnv>): Promise<never> {
  const row = await c.env.DB.prepare('SELECT id FROM items WHERE id = ? AND project_id = ? AND deleted_at IS NULL').bind(c.req.param('itemId'), c.req.param('projectId')).first();
  throw new HTTPException(row ? 409 : 404, { message: row ? 'Version conflict; read the item and retry' : 'Item not found' });
}
itemsApi.delete('/:itemId', async (c) => {
  const input = await body(c, z.object({ version }).strict());
  const time = new Date().toISOString();
  const result = await c.env.DB.prepare('UPDATE items SET deleted_at = ?, updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ? AND project_id = ? AND version = ? AND deleted_at IS NULL')
    .bind(time, time, c.get('principal').id, c.req.param('itemId'), c.req.param('projectId'), input.version).run();
  if (!result.meta.changes) await conflictOrMissing(c);
  return c.body(null, 204);
});
