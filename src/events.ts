import { z } from 'zod';

export const messageEventName = 'role.messages.received';
export const messageEventFilters = z.object({ project_id: z.uuid(), recipient_role_id: z.uuid() }).strict();

export const messageEvent = {
  name: messageEventName,
  inputSchema: { type: 'object', properties: { project_id: { type: 'string', format: 'uuid' }, recipient_role_id: { type: 'string', format: 'uuid' } }, required: ['project_id', 'recipient_role_id'], additionalProperties: false },
  payloadSchema: { type: 'object', properties: {
    project_id: { type: 'string' }, recipient_role_id: { type: 'string' }, message_count: { type: 'integer', minimum: 1 },
    first_message_id: { type: 'string' }, last_message_id: { type: 'string' },
    first_received_at: { type: 'string' }, last_received_at: { type: 'string' },
  }, required: ['project_id', 'recipient_role_id', 'message_count', 'first_message_id', 'last_message_id', 'first_received_at', 'last_received_at'], additionalProperties: false },
};
