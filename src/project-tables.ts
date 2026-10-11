import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv } from './types';
import { body, pagination } from './http';
import { ownerOnly } from './security';

const columnSchema = z.object({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,62}$/),
  type: z.enum(['text', 'integer', 'real', 'boolean', 'json']),
  required: z.boolean().default(false),
}).strict();
const fields = z.object({ name: z.string().trim().min(1).max(100), description: z.string().max(5000) });
const createSchema = fields.extend({ description: fields.shape.description.default(''), columns: z.array(columnSchema).min(1).max(32).refine((columns) => new Set(columns.map((column) => column.name.toLowerCase())).size === columns.length, 'Column names must be unique') }).strict();
type Column = z.infer<typeof columnSchema>;
type Table = { id: string; project_id: string; name: string; description: string; columns_json: string; created_at: string; updated_at: string };
const valuesSchema = z.record(z.string(), z.unknown());
const versionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
// Physical identifiers come exclusively from server-generated IDs, never SQL supplied by a client.
function physical(id: string) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new HTTPException(404, { message: 'Table not found' });
  return quote('project_data_' + id.replaceAll('-', ''));
}
function tableData(table: Table) {
  const { columns_json, ...data } = table;
  return { ...data, columns: JSON.parse(columns_json) as Column[] };
}
async function findTable(c: Context<AppEnv>) {
  physical(c.req.param('tableId')!);
  const table = await c.env.DB.prepare('SELECT * FROM project_tables WHERE id = ? AND project_id = ?').bind(c.req.param('tableId'), c.req.param('projectId')).first<Table>();
  if (!table) throw new HTTPException(404, { message: 'Table not found' });
  return tableData(table);
}
function encode(column: Column, value: unknown): string | number | null {
  if (value === null) {
    if (column.required) throw new HTTPException(400, { message: `Column ${column.name} is required` });
    return null;
  }
  const valid = column.type === 'text' ? typeof value === 'string' && value.length <= 20000
    : column.type === 'integer' ? typeof value === 'number' && Number.isSafeInteger(value)
    : column.type === 'real' ? typeof value === 'number' && Number.isFinite(value)
    : column.type === 'boolean' ? typeof value === 'boolean' : value !== undefined;
  if (!valid) throw new HTTPException(400, { message: `Invalid ${column.type} value for ${column.name}` });
  if (column.type === 'json') {
    const json = JSON.stringify(value);
    if (!json || json.length > 20000) throw new HTTPException(400, { message: 'JSON value exceeds 20000 characters' });
    return json;
  }
  return column.type === 'boolean' ? Number(value) : value as string | number;
}
function inputValues(columns: Column[], values: Record<string, unknown>, partial: boolean) {
  if (Object.keys(values).some((key) => !columns.some((column) => column.name === key))) throw new HTTPException(400, { message: 'Unknown column' });
  const selected = partial ? columns.filter((column) => Object.hasOwn(values, column.name)) : columns;
  if (partial && !selected.length) throw new HTTPException(400, { message: 'At least one column is required' });
  return { selected, bindings: selected.map((column) => encode(column, Object.hasOwn(values, column.name) ? values[column.name] : null)) };
}
function rowData(row: Record<string, unknown>, columns: Column[]) {
  const values = Object.fromEntries(columns.map((column) => {
    const value = row[column.name];
    return [column.name, value === null ? null : column.type === 'boolean' ? Boolean(value) : column.type === 'json' ? JSON.parse(value as string) : value];
  }));
  return { id: row._id, version: row._version, created_at: row._created_at, updated_at: row._updated_at, values };
}
async function duplicateName(c: Context<AppEnv>, name: string, except = '') {
  if (await c.env.DB.prepare('SELECT id FROM project_tables WHERE project_id = ? AND name = ? COLLATE NOCASE AND id != ?').bind(c.req.param('projectId'), name, except).first()) throw new HTTPException(409, { message: 'Table name already exists' });
}
async function nameConflict<T>(operation: () => Promise<T>) {
  try { return await operation(); }
  catch (error) {
    const messages = error instanceof Error ? error.message + (error.cause instanceof Error ? error.cause.message : '') : '';
    if (messages.includes('UNIQUE constraint failed: project_tables.project_id, project_tables.name')) throw new HTTPException(409, { message: 'Table name already exists' });
    throw error;
  }
}
export const projectTables = new Hono<AppEnv>();
projectTables.get('/', async (c) => {
  const { limit, after } = pagination(c);
  const rows = await c.env.DB.prepare('SELECT * FROM project_tables WHERE project_id = ? AND id > ? ORDER BY id LIMIT ?').bind(c.req.param('projectId'), after, limit + 1).all<Table>();
  const data = rows.results.slice(0, limit).map(tableData);
  return c.json({ data, next_cursor: rows.results.length > limit ? data.at(-1)!.id : null });
});
projectTables.post('/', async (c) => {
  ownerOnly(c);
  const input = await body(c, createSchema);
  await duplicateName(c, input.name);
  const id = crypto.randomUUID(), timestamp = new Date().toISOString();
  const sqlTypes = { text: 'TEXT', integer: 'INTEGER', real: 'REAL', boolean: 'INTEGER', json: 'TEXT' };
  await nameConflict(() => c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO project_tables (id, project_id, name, description, columns_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, c.req.param('projectId'), input.name, input.description, JSON.stringify(input.columns), timestamp, timestamp),
    c.env.DB.prepare(`CREATE TABLE ${physical(id)} (_id TEXT PRIMARY KEY, _version INTEGER NOT NULL, _created_at TEXT NOT NULL, _updated_at TEXT NOT NULL, ${input.columns.map((column) => `${quote(column.name)} ${sqlTypes[column.type]}${column.required ? ' NOT NULL' : ''}`).join(', ')})`),
  ]));
  return c.json({ data: { id, project_id: c.req.param('projectId'), ...input, created_at: timestamp, updated_at: timestamp } }, 201);
});
projectTables.get('/:tableId', async (c) => c.json({ data: await findTable(c) }));
projectTables.patch('/:tableId', async (c) => {
  ownerOnly(c);
  const table = await findTable(c);
  const input = await body(c, fields.partial().strict().refine((value) => Object.keys(value).length > 0, 'At least one field is required'));
  if (input.name) await duplicateName(c, input.name, table.id);
  await nameConflict(() => c.env.DB.prepare('UPDATE project_tables SET name = ?, description = ?, updated_at = ? WHERE id = ? AND project_id = ?').bind(input.name ?? table.name, input.description ?? table.description, new Date().toISOString(), table.id, table.project_id).run());
  return c.json({ data: await findTable(c) });
});
projectTables.delete('/:tableId', async (c) => {
  ownerOnly(c);
  const table = await findTable(c);
  await c.env.DB.batch([c.env.DB.prepare(`DROP TABLE ${physical(table.id)}`), c.env.DB.prepare('DELETE FROM project_tables WHERE id = ? AND project_id = ?').bind(table.id, table.project_id)]);
  return c.body(null, 204);
});
const filterSchema = z.array(z.object({ column: z.string(), op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'is_null']), value: z.unknown().optional() }).strict()).max(20);
projectTables.get('/:tableId/rows', async (c) => {
  const table = await findTable(c), { limit, after } = pagination(c);
  const raw = c.req.query('filters') ?? '[]';
  let filters: z.infer<typeof filterSchema>;
  try { if (raw.length > 16000) throw new Error(); filters = filterSchema.parse(JSON.parse(raw)); }
  catch { throw new HTTPException(400, { message: 'filters must be a JSON array of up to 20 conditions' }); }
  const clauses = ['_id > ?'], bindings: (string | number | null)[] = [after];
  const operators = { eq: '=', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };
  for (const filter of filters) {
    const column = table.columns.find((column) => column.name === filter.column);
    if (!column) throw new HTTPException(400, { message: 'Unknown filter column' });
    if (filter.op === 'is_null') { clauses.push(`${quote(column.name)} IS NULL`); continue; }
    if (filter.value === undefined) throw new HTTPException(400, { message: 'Filter value required' });
    if (filter.value === null && ['eq', 'ne'].includes(filter.op)) { clauses.push(`${quote(column.name)} IS ${filter.op === 'ne' ? 'NOT ' : ''}NULL`); continue; }
    const value = encode(column, filter.value);
    if (filter.op === 'contains') {
      if (column.type !== 'text' || typeof value !== 'string') throw new HTTPException(400, { message: 'contains requires a text column and string value' });
      clauses.push(`instr(${quote(column.name)}, ?) > 0`);
    } else clauses.push(`${quote(column.name)} ${operators[filter.op]} ?`);
    bindings.push(value);
  }
  const rows = await c.env.DB.prepare(`SELECT * FROM ${physical(table.id)} WHERE ${clauses.join(' AND ')} ORDER BY _id LIMIT ?`).bind(...bindings, limit + 1).all<Record<string, unknown>>();
  const data = rows.results.slice(0, limit).map((row) => rowData(row, table.columns));
  return c.json({ data, next_cursor: rows.results.length > limit ? data.at(-1)!.id : null });
});
projectTables.post('/:tableId/rows', async (c) => {
  const table = await findTable(c), input = await body(c, z.object({ values: valuesSchema }).strict());
  const { selected, bindings } = inputValues(table.columns, input.values, false);
  const id = crypto.randomUUID(), timestamp = new Date().toISOString();
  const row = await c.env.DB.prepare(`INSERT INTO ${physical(table.id)} (_id, _version, _created_at, _updated_at, ${selected.map((column) => quote(column.name)).join(', ')}) VALUES (?, 1, ?, ?, ${selected.map(() => '?').join(', ')}) RETURNING *`).bind(id, timestamp, timestamp, ...bindings).first<Record<string, unknown>>();
  return c.json({ data: rowData(row!, table.columns) }, 201);
});
projectTables.get('/:tableId/rows/:rowId', async (c) => {
  const table = await findTable(c);
  const row = await c.env.DB.prepare(`SELECT * FROM ${physical(table.id)} WHERE _id = ?`).bind(c.req.param('rowId')).first<Record<string, unknown>>();
  if (!row) throw new HTTPException(404, { message: 'Row not found' });
  return c.json({ data: rowData(row, table.columns) });
});
projectTables.patch('/:tableId/rows/:rowId', async (c) => {
  const table = await findTable(c), input = await body(c, z.object({ values: valuesSchema, version: versionSchema }).strict());
  const { selected, bindings } = inputValues(table.columns, input.values, true);
  const row = await c.env.DB.prepare(`UPDATE ${physical(table.id)} SET ${selected.map((column) => `${quote(column.name)} = ?`).join(', ')}, _version = _version + 1, _updated_at = ? WHERE _id = ? AND _version = ? RETURNING *`).bind(...bindings, new Date().toISOString(), c.req.param('rowId'), input.version).first<Record<string, unknown>>();
  if (!row) await rowFailure(c, table.id);
  return c.json({ data: rowData(row!, table.columns) });
});
async function rowFailure(c: Context<AppEnv>, tableId: string) {
  const exists = await c.env.DB.prepare(`SELECT _id FROM ${physical(tableId)} WHERE _id = ?`).bind(c.req.param('rowId')).first();
  throw new HTTPException(exists ? 409 : 404, { message: exists ? 'Version conflict; read the row and retry' : 'Row not found' });
}
projectTables.delete('/:tableId/rows/:rowId', async (c) => {
  const table = await findTable(c), input = await body(c, z.object({ version: versionSchema }).strict());
  const result = await c.env.DB.prepare(`DELETE FROM ${physical(table.id)} WHERE _id = ? AND _version = ?`).bind(c.req.param('rowId'), input.version).run();
  if (!result.meta.changes) await rowFailure(c, table.id);
  return c.body(null, 204);
});
