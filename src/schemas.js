import { z } from 'zod';

const error = z.object({ code: z.string(), action: z.string(), detail: z.string().optional() }).strict();
const snapshotShape = {
  taskId: z.string().uuid(), workspace: z.string(),
  status: z.enum(['starting', 'idle', 'running', 'queued', 'settled', 'cancelling', 'cancelled', 'closed', 'failed', 'timed_out', 'cleanup_unconfirmed']),
  createdAt: z.number(), updatedAt: z.number(), eventCursor: z.number().int(),
  lastDisposition: z.enum(['started', 'queued', 'handled']).nullable(), error: error.nullable(),
  cleanupError: error.nullable(), cleanupStatus: z.enum(['pending', 'confirmed', 'unconfirmed']),
  pendingMessages: z.number().int(), queuedMessageBytes: z.number().int(),
  processExited: z.boolean(), pendingCommands: z.number().int(), outputMode: z.enum(['metadata', 'redacted_text'])
};
const snapshot = z.object(snapshotShape).strict();
const event = z.object({ seq: z.number().int(), time: z.number(), type: z.string(),
  role: z.string().optional(), stopReason: z.string().optional(), tool: z.string().optional(),
  isError: z.boolean().optional(), steeringCount: z.number().int().optional(), followupCount: z.number().int().optional(),
  commandId: z.string().uuid().optional(), mode: z.string().optional(), disposition: z.string().optional(),
  code: z.string().optional(), action: z.string().optional(), status: z.string().optional()
}).strict();

export const outputSchemas = {
  list_workspaces: z.object({ workspaces: z.array(z.string()) }).strict(),
  create_task: snapshot,
  send_message: z.object({ taskId: z.string().uuid(), commandId: z.string().uuid(),
    acceptedByService: z.literal(true), acceptedByPi: z.literal(false) }).strict(),
  list_tasks: z.object({ tasks: z.array(snapshot) }).strict(),
  get_status: snapshot,
  get_events: z.object({ taskId: z.string().uuid(), events: z.array(event).max(50),
    nextCursor: z.number().int(), gap: z.boolean(), oldestCursor: z.number().int(), hasMore: z.boolean() }).strict(),
  get_result: z.object({ ...snapshotShape, available: z.boolean(), final: z.boolean(),
    stopReason: z.string().optional(), text: z.string().optional(), truncated: z.boolean().optional(),
    textWithheld: z.boolean().optional() }).strict(),
  abort_task: snapshot
};
