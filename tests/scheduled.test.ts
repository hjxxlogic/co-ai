import { describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import type { Env } from '../src/types';
import { deliverMessageEvents } from '../src/mcp-events';
import { cleanupMcpDebugLogs } from '../src/mcp-debug';

vi.mock('../src/mcp-events', async (original) => ({
  ...await original<typeof import('../src/mcp-events')>(), deliverMessageEvents: vi.fn(async () => {}),
}));
vi.mock('../src/mcp-debug', async (original) => ({
  ...await original<typeof import('../src/mcp-debug')>(), cleanupMcpDebugLogs: vi.fn(async () => {}),
}));

describe('scheduled maintenance', () => {
  it('delivers events every minute and cleans logs every five scheduled minutes, even on delayed execution', async () => {
    vi.clearAllMocks();
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) } as unknown as ExecutionContext;
    for (let minute = 0; minute < 10; minute++) {
      app.scheduled({ scheduledTime: Date.UTC(2026, 10, 1, 0, minute) } as ScheduledController, {} as Env, ctx);
    }
    await Promise.all(pending);
    expect(deliverMessageEvents).toHaveBeenCalledTimes(10);
    expect(cleanupMcpDebugLogs).toHaveBeenCalledTimes(2);
  });
});
