import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv } from './types';
import { body, pagination } from './http';

export const workflowsApi = new Hono<AppEnv>();
export const worksApi = new Hono<AppEnv>();

const id = z.uuid();
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const title = z.string().trim().min(1).max(200);
const stateId = z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_]*$/);
const definition = z.object({
  initial_state: stateId,
  states: z.array(z.object({ id: stateId, name: z.string().trim().min(1).max(100) }).strict()).min(2).max(32),
  transitions: z.array(z.object({ from: stateId, to: stateId }).strict()).max(128),
}).strict().superRefine((value, context) => {
  const states = new Map(value.states.map((state) => [state.id, state]));
  if (states.size !== value.states.length) context.addIssue({ code: 'custom', message: 'State IDs must be unique' });
  if (states.get('end')?.name !== '结束') context.addIssue({ code: 'custom', message: 'An end state named 结束 is required' });
  if (value.initial_state === 'end' || !states.has(value.initial_state)) context.addIssue({ code: 'custom', message: 'Initial state must be a non-end state' });
  const edges = new Set<string>();
  const forward = new Map([...states.keys()].map((key) => [key, [] as string[]]));
  const backward = new Map([...states.keys()].map((key) => [key, [] as string[]]));
  for (const edge of value.transitions) {
    const key = `${edge.from}\0${edge.to}`;
    if (!states.has(edge.from) || !states.has(edge.to) || edge.from === 'end' || edge.from === edge.to || edges.has(key)) {
      context.addIssue({ code: 'custom', message: 'Invalid or duplicate transition' });
    } else {
      forward.get(edge.from)!.push(edge.to);
      backward.get(edge.to)!.push(edge.from);
    }
    edges.add(key);
  }
  const reachable = (start: string, graph: Map<string, string[]>) => {
    const seen = new Set<string>(), pending = [start];
    while (pending.length) {
      const node = pending.pop()!;
      if (seen.has(node)) continue;
      seen.add(node);
      pending.push(...(graph.get(node) ?? []));
    }
    return seen;
  };
  const fromStart = reachable(value.initial_state, forward), toEnd = reachable('end', backward);
  if ([...states.keys()].some((key) => !fromStart.has(key) || !toEnd.has(key))) context.addIssue({ code: 'custom', message: 'Every state must be reachable and lead to end' });
});
type Definition = z.infer<typeof definition>;
type Template = { id: string; project_id: string; name: string; description: string; version: number; current_revision_id: string; created_by: string; updated_by: string; created_at: string; updated_at: string };
type Revision = { id: string; template_id: string; revision: number; definition: string; created_by: string; created_at: string };
type Work = { id: string; project_id: string; template_id: string; revision_id: string; title: string; desc: string; current_state: string; current_message_item_id: string | null; version: number; created_by: string; updated_by: string; created_at: string; updated_at: string };
const templateCreate = z.object({ name: title, description: z.string().max(2000).default('') }).extend(definition.shape).strict();
const templatePatch = z.object({ version, name: title.optional(), description: z.string().max(2000).optional(), initial_state: stateId.optional(), states: definition.shape.states.optional(), transitions: definition.shape.transitions.optional() }).strict().refine((value) => Object.keys(value).length > 1, 'At least one changed field is required');
const messageId = id.nullable();
const workCreate = z.object({ workflow_id: id, title, desc: z.string().max(2000).default(''), message_item_id: messageId.default(null) }).strict();
const workPatch = z.object({ version, title: title.optional(), desc: z.string().max(2000).optional(), message_item_id: messageId.optional() }).strict().refine((value) => Object.keys(value).length > 1, 'At least one changed field is required');
const transitionInput = z.object({ version, to_state: stateId, message_item_id: messageId.default(null) }).strict();
const timestamp = z.iso.datetime({ offset: true });
const now = () => new Date().toISOString();

function timeFilter(raw: string | undefined, name: string) {
  if (raw === undefined) return null;
  if (!timestamp.safeParse(raw).success || !Number.isFinite(Date.parse(raw))) throw new HTTPException(400, { message: `${name} must be an ISO 8601 timestamp with timezone` });
  return new Date(raw).toISOString();
}

function scoped(c: Context<AppEnv>) { return c.req.param('projectId')!; }
function invalidId(value: string) { if (!id.safeParse(value).success) throw new HTTPException(404, { message: 'Not found' }); }
function serializedTemplate(template: Template, revision: Revision) {
  return { ...template, revision: revision.revision, definition: JSON.parse(revision.definition) as Definition };
}
async function findTemplate(c: Context<AppEnv>) {
  invalidId(c.req.param('workflowId') ?? '');
  const row = await c.env.DB.prepare('SELECT * FROM workflow_templates WHERE id = ? AND project_id = ?').bind(c.req.param('workflowId'), scoped(c)).first<Template>();
  if (!row) throw new HTTPException(404, { message: 'Workflow not found' });
  return row;
}
async function findWork(c: Context<AppEnv>) {
  invalidId(c.req.param('workId') ?? '');
  const row = await c.env.DB.prepare('SELECT * FROM works WHERE id = ? AND project_id = ?').bind(c.req.param('workId'), scoped(c)).first<Work>();
  if (!row) throw new HTTPException(404, { message: 'Work not found' });
  return row;
}
async function validMessage(c: Context<AppEnv>, itemId: string | null | undefined) {
  if (itemId === undefined || itemId === null) return;
  const row = await c.env.DB.prepare("SELECT id FROM items WHERE id = ? AND project_id = ? AND kind = 'message' AND deleted_at IS NULL").bind(itemId, scoped(c)).first();
  if (!row) throw new HTTPException(400, { message: 'message_item_id must refer to an active project message' });
}
function databaseError(error: unknown): never {
  const message = error instanceof Error ? error.message + (error.cause instanceof Error ? error.cause.message : '') : '';
  if (message.includes('Invalid work message')) throw new HTTPException(400, { message: 'message_item_id must refer to an active project message' });
  if (message.includes('Work message is referenced')) throw new HTTPException(409, { message: 'Work message is referenced' });
  if (message.includes('workflow_templates.project_id, workflow_templates.name')) throw new HTTPException(409, { message: 'Workflow name already exists' });
  throw error;
}
async function currentRevision(c: Context<AppEnv>, template: Template) {
  const row = await c.env.DB.prepare('SELECT * FROM workflow_revisions WHERE id = ? AND template_id = ?').bind(template.current_revision_id, template.id).first<Revision>();
  if (!row) throw new HTTPException(500, { message: 'Workflow revision missing' });
  return row;
}
function page(c: Context<AppEnv>) {
  const { limit, after } = pagination(c);
  if (after) invalidId(after);
  return { limit, after };
}

workflowsApi.get('/', async (c) => {
  const { limit, after } = page(c);
  const { results } = await c.env.DB.prepare('SELECT * FROM workflow_templates WHERE project_id = ? AND id > ? ORDER BY id LIMIT ?').bind(scoped(c), after, limit + 1).all<Template>();
  const data = results.slice(0, limit);
  return c.json({ data, next_cursor: results.length > limit ? data.at(-1)!.id : null });
});
workflowsApi.post('/', async (c) => {
  const input = await body(c, templateCreate);
  const { name, description, ...raw } = input;
  const parsed = definition.safeParse(raw);
  if (!parsed.success) throw new HTTPException(400, { message: z.prettifyError(parsed.error) });
  const workflowId = crypto.randomUUID(), revisionId = crypto.randomUUID(), timestamp = now(), actor = c.get('principal').id;
  try {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO workflow_templates (id, project_id, name, description, current_revision_id, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(workflowId, scoped(c), name, description, revisionId, actor, actor, timestamp, timestamp),
      c.env.DB.prepare('INSERT INTO workflow_revisions (id, template_id, revision, definition, created_by, created_at) VALUES (?, ?, 1, ?, ?, ?)').bind(revisionId, workflowId, JSON.stringify(parsed.data), actor, timestamp),
    ]);
  } catch (error) { databaseError(error); }
  return c.json({ data: serializedTemplate((await c.env.DB.prepare('SELECT * FROM workflow_templates WHERE id = ?').bind(workflowId).first<Template>())!, (await c.env.DB.prepare('SELECT * FROM workflow_revisions WHERE id = ?').bind(revisionId).first<Revision>())!) }, 201);
});
workflowsApi.get('/:workflowId', async (c) => {
  const template = await findTemplate(c);
  const raw = c.req.query('revision');
  if (raw !== undefined && (!/^\d+$/.test(raw) || Number(raw) < 1 || !Number.isSafeInteger(Number(raw)))) throw new HTTPException(400, { message: 'revision must be a positive integer' });
  const revision = raw === undefined ? await currentRevision(c, template) : await c.env.DB.prepare('SELECT * FROM workflow_revisions WHERE template_id = ? AND revision = ?').bind(template.id, Number(raw)).first<Revision>();
  if (!revision) throw new HTTPException(404, { message: 'Workflow revision not found' });
  return c.json({ data: serializedTemplate(template, revision) });
});
workflowsApi.patch('/:workflowId', async (c) => {
  const input = await body(c, templatePatch), template = await findTemplate(c);
  const supplied = [input.initial_state, input.states, input.transitions].filter((value) => value !== undefined).length;
  if (supplied !== 0 && supplied !== 3) throw new HTTPException(400, { message: 'Provide all definition fields together' });
  const parsed = supplied ? definition.safeParse({ initial_state: input.initial_state, states: input.states, transitions: input.transitions }) : null;
  if (parsed && !parsed.success) throw new HTTPException(400, { message: z.prettifyError(parsed.error) });
  const nextRevisionId = parsed ? crypto.randomUUID() : template.current_revision_id;
  const actor = c.get('principal').id, timestamp = now();
  try {
    const results = await c.env.DB.batch([
      c.env.DB.prepare('UPDATE workflow_templates SET name = COALESCE(?, name), description = COALESCE(?, description), version = version + 1, current_revision_id = ?, updated_by = ?, updated_at = ? WHERE id = ? AND project_id = ? AND version = ?').bind(input.name ?? null, input.description ?? null, nextRevisionId, actor, timestamp, template.id, scoped(c), input.version),
      ...(parsed ? [c.env.DB.prepare('INSERT INTO workflow_revisions (id, template_id, revision, definition, created_by, created_at) SELECT ?, id, (SELECT COALESCE(MAX(revision), 0) + 1 FROM workflow_revisions WHERE template_id = ?), ?, ?, ? FROM workflow_templates WHERE id = ? AND current_revision_id = ?').bind(nextRevisionId, template.id, JSON.stringify(parsed.data), actor, timestamp, template.id, nextRevisionId)] : []),
    ]);
    if (!results[0].meta.changes) throw new HTTPException(409, { message: 'Version conflict; read the workflow and retry' });
  } catch (error) { databaseError(error); }
  const updated = await findTemplate(c);
  return c.json({ data: serializedTemplate(updated, await currentRevision(c, updated)) });
});

worksApi.get('/', async (c) => {
  const { limit, after } = page(c), workflowId = c.req.query('workflow_id'), state = c.req.query('state');
  if (workflowId !== undefined) invalidId(workflowId);
  if (state !== undefined && !stateId.safeParse(state).success) throw new HTTPException(400, { message: 'Invalid state' });
  const since = timeFilter(c.req.query('updated_since'), 'updated_since');
  const until = timeFilter(c.req.query('updated_until'), 'updated_until');
  if (since && until && since > until) throw new HTTPException(400, { message: 'updated_since must not be after updated_until' });
  const where = ['project_id = ?', 'id > ?'];
  const bindings: (string | number)[] = [scoped(c), after];
  if (workflowId) { where.push('template_id = ?'); bindings.push(workflowId); }
  if (state) { where.push('current_state = ?'); bindings.push(state); }
  if (since) { where.push('updated_at >= ?'); bindings.push(since); }
  if (until) { where.push('updated_at <= ?'); bindings.push(until); }
  const { results } = await c.env.DB.prepare(`SELECT * FROM works WHERE ${where.join(' AND ')} ORDER BY id LIMIT ?`)
    .bind(...bindings, limit + 1).all<Work>();
  const data = results.slice(0, limit);
  return c.json({ data, next_cursor: results.length > limit ? data.at(-1)!.id : null });
});
worksApi.post('/', async (c) => {
  const input = await body(c, workCreate);
  await validMessage(c, input.message_item_id);
  const template = await c.env.DB.prepare('SELECT * FROM workflow_templates WHERE id = ? AND project_id = ?').bind(input.workflow_id, scoped(c)).first<Template>();
  if (!template) throw new HTTPException(404, { message: 'Workflow not found' });
  const revision = await currentRevision(c, template), state = (JSON.parse(revision.definition) as Definition).initial_state;
  const workId = crypto.randomUUID(), actor = c.get('principal').id, timestamp = now();
  try {
    const result = await c.env.DB.prepare('INSERT INTO works (id, project_id, template_id, revision_id, title, "desc", current_state, current_message_item_id, created_by, updated_by, created_at, updated_at) SELECT ?, project_id, id, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM workflow_templates WHERE id = ? AND project_id = ? AND current_revision_id = ?')
      .bind(workId, revision.id, input.title, input.desc, state, input.message_item_id, actor, actor, timestamp, timestamp, template.id, scoped(c), revision.id).run();
    if (!result.meta.changes) throw new HTTPException(409, { message: 'Workflow changed; read it and retry' });
  } catch (error) { databaseError(error); }
  return c.json({ data: await c.env.DB.prepare('SELECT * FROM works WHERE id = ?').bind(workId).first<Work>() }, 201);
});
worksApi.get('/:workId', async (c) => c.json({ data: await findWork(c) }));
worksApi.patch('/:workId', async (c) => {
  const input = await body(c, workPatch), work = await findWork(c);
  await validMessage(c, input.message_item_id);
  const timestamp = now();
  try {
    const result = await c.env.DB.prepare('UPDATE works SET title = COALESCE(?, title), "desc" = COALESCE(?, "desc"), current_message_item_id = CASE WHEN ? = 1 THEN ? ELSE current_message_item_id END, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND project_id = ? AND version = ?')
      .bind(input.title ?? null, input.desc ?? null, Number(input.message_item_id !== undefined), input.message_item_id ?? null, c.get('principal').id, timestamp, work.id, scoped(c), input.version).run();
    if (!result.meta.changes) throw new HTTPException(409, { message: 'Version conflict; read the work and retry' });
  } catch (error) { databaseError(error); }
  return c.json({ data: await findWork(c) });
});
worksApi.post('/:workId/transitions', async (c) => {
  const input = await body(c, transitionInput), work = await findWork(c);
  await validMessage(c, input.message_item_id);
  if (work.current_state === 'end') throw new HTTPException(409, { message: 'Work is complete' });
  const revision = await c.env.DB.prepare('SELECT * FROM workflow_revisions WHERE id = ? AND template_id = ?').bind(work.revision_id, work.template_id).first<Revision>();
  if (!revision) throw new HTTPException(500, { message: 'Workflow revision missing' });
  if (!(JSON.parse(revision.definition) as Definition).transitions.some((edge) => edge.from === work.current_state && edge.to === input.to_state)) throw new HTTPException(400, { message: 'Transition is not allowed' });
  try {
    const result = await c.env.DB.prepare('UPDATE works SET current_state = ?, current_message_item_id = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND project_id = ? AND version = ? AND current_state = ?')
      .bind(input.to_state, input.message_item_id, c.get('principal').id, now(), work.id, scoped(c), input.version, work.current_state).run();
    if (!result.meta.changes) throw new HTTPException(409, { message: 'Version conflict; read the work and retry' });
  } catch (error) { databaseError(error); }
  return c.json({ data: await findWork(c) });
});
worksApi.get('/:workId/history', async (c) => {
  const work = await findWork(c), { limit } = pagination(c);
  const raw = c.req.query('after') ?? '0';
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new HTTPException(400, { message: 'after must be a history sequence' });
  const { results } = await c.env.DB.prepare('SELECT * FROM work_history WHERE work_id = ? AND sequence > ? ORDER BY sequence LIMIT ?').bind(work.id, Number(raw), limit + 1).all<{ sequence: number }>();
  const data = results.slice(0, limit);
  return c.json({ data, next_cursor: results.length > limit ? String(data.at(-1)!.sequence) : null });
});
