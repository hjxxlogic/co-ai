import openapi from '../llm/openapi.json';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

type Schema = Record<string, unknown>;
interface Parameter {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema: Schema;
}
interface Operation {
  operationId: string;
  summary: string;
  parameters?: Parameter[];
  requestBody?: { required?: boolean; content: Record<string, { schema: Schema }> };
}
export interface RestTool {
  tool: Tool;
  method: string;
  path: string;
  parameters: Parameter[];
  binaryUpload: boolean;
  binaryDownload: boolean;
}

// Keep the tool catalog and REST contract together. Inline local references so
// MCP clients can read each input schema without resolving an OpenAPI document.
function resolveSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(resolveSchema);
  if (!value || typeof value !== 'object') return value;
  const schema = value as Schema;
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.replace('#/components/schemas/', '');
    const referenced = (openapi.components.schemas as Record<string, unknown>)[name];
    if (!referenced) throw new Error('Unknown REST schema reference');
    const { $ref: _ref, ...siblings } = schema;
    return { ...resolveSchema(referenced) as Schema, ...resolveSchema(siblings) as Schema };
  }
  return Object.fromEntries(Object.entries(schema).map(([key, child]) => [key, resolveSchema(child)]));
}

export const restTools: RestTool[] = Object.entries(openapi.paths).flatMap(([path, operations]) =>
  Object.entries(operations).map(([method, value]) => {
    const operation = value as Operation;
    const parameters = operation.parameters ?? [];
    const properties: Record<string, object> = {};
    const required: string[] = [];
    for (const parameter of parameters) {
      properties[parameter.name] = { ...resolveSchema(parameter.schema) as Schema, ...(parameter.description ? { description: parameter.description } : {}) };
      if (parameter.required) required.push(parameter.name);
    }
    const jsonBody = operation.requestBody?.content['application/json'];
    const binaryUpload = Boolean(operation.requestBody?.content['application/octet-stream']);
    const binaryDownload = method === 'get' && path.endsWith('/attachments/{attachmentId}');
    if (jsonBody) {
      properties.body = resolveSchema(jsonBody.schema) as Schema;
      if (operation.requestBody?.required) required.push('body');
    }
    if (binaryUpload) {
      properties.content_base64 = {
        type: 'string', maxLength: 4 * Math.ceil(10 * 1024 * 1024 / 3),
        description: 'Standard padded Base64 of the complete attachment, up to 10 MiB decoded.',
      };
      properties.content_type = { type: 'string', maxLength: 200, default: 'application/octet-stream' };
      required.push('content_base64');
    }
    const description = `${operation.summary}. REST: ${method.toUpperCase()} ${path}. Same authentication and permissions as REST; pass credentials via HTTP Authorization/Cookie headers.${binaryDownload ? ' Returns file bytes as content_base64 in structuredContent.body.data.' : ''}`;
    return {
      tool: {
        name: operation.operationId,
        description,
        inputSchema: { type: 'object', properties, required, additionalProperties: false },
        annotations: {
          readOnlyHint: method === 'get',
          destructiveHint: method === 'delete' || method === 'patch' || method === 'put' || path.endsWith('/reset-key'),
          idempotentHint: method === 'get',
          openWorldHint: false,
        },
      },
      method: method.toUpperCase(), path, parameters, binaryUpload, binaryDownload,
    };
  }),
);
