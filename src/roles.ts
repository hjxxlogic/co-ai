import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv } from './types';
import { body, pagination } from './http';
import { ownerOnly } from './security';

export async function activeRole(c: Context<AppEnv>, id: string | null | undefined) {
  if (!id) return null;
  const row = await c.env.DB.prepare('SELECT id, name FROM roles WHERE id = ? AND project_id = ? AND archived_at IS NULL')
    .bind(id, c.req.param('projectId')).first<{ id: string; name: string }>();
  if (!row) throw new HTTPException(400, { message: 'Role must be active and belong to this project' });
  return row;
}

export const rolesApi = new Hono<AppEnv>();
const fields = z.object({ name: z.string().trim().min(1).max(100), description: z.string().max(2000) }).strict();
rolesApi.get('/', async (c) => {
  const { limit, after } = pagination(c);
  const archived = c.req.query('include_archived') ?? 'false';
  if (!['true', 'false'].includes(archived)) throw new HTTPException(400, { message: 'include_archived must be true or false' });
  const { results } = await c.env.DB.prepare('SELECT * FROM roles WHERE project_id = ? AND id > ? AND (? = 1 OR archived_at IS NULL) ORDER BY id LIMIT ?')
    .bind(c.req.param('projectId'), after, Number(archived === 'true'), limit + 1).all<{ id: string }>();
  const data = results.slice(0, limit);
  return c.json({ data, next_cursor: results.length > limit ? data.at(-1)!.id : null });
});
rolesApi.post('/', async (c) => {
  ownerOnly(c);
  const input = await body(c, fields.extend({ description: fields.shape.description.default('') }));
  const timestamp = new Date().toISOString();
  const id = crypto.randomUUID();
  try {
    const row = await c.env.DB.prepare('INSERT INTO roles (id, project_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *')
      .bind(id, c.req.param('projectId'), input.name, input.description, timestamp, timestamp).first();
    return c.json({ data: row }, 201);
  } catch (error) {
    if (await c.env.DB.prepare('SELECT id FROM roles WHERE project_id = ? AND name = ?').bind(c.req.param('projectId'), input.name).first()) throw new HTTPException(409, { message: 'Role name already exists in this project' });
    throw error;
  }
});
rolesApi.patch('/:roleId', async (c) => {
  ownerOnly(c);
  const input = await body(c, fields.partial().extend({ archived: z.boolean().optional() }).refine((v) => Object.keys(v).length > 0, 'At least one field is required'));
  const id = c.req.param('roleId'), projectId = c.req.param('projectId');
  const timestamp = new Date().toISOString();
  try {
    const statements = [c.env.DB.prepare('UPDATE roles SET name = COALESCE(?, name), description = COALESCE(?, description), archived_at = CASE WHEN ? IS NULL THEN archived_at WHEN ? = 1 THEN ? ELSE NULL END, updated_at = ? WHERE id = ? AND project_id = ? RETURNING *')
      .bind(input.name ?? null, input.description ?? null, input.archived === undefined ? null : Number(input.archived), Number(input.archived ?? false), timestamp, timestamp, id, projectId)];
    const row = (await c.env.DB.batch(statements))[0].results[0];
    if (!row) throw new HTTPException(404, { message: 'Role not found' });
    return c.json({ data: row });
  } catch (error) {
    if (input.name && await c.env.DB.prepare('SELECT id FROM roles WHERE project_id = ? AND name = ? AND id != ?').bind(projectId, input.name, id).first()) throw new HTTPException(409, { message: 'Role name already exists in this project' });
    throw error;
  }
});
