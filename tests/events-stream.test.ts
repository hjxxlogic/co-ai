import { expect, it, vi } from 'vitest';
import { eventStream } from '../src/events-stream';

class BridgeSocket extends EventTarget {
  accept = vi.fn();
  close = vi.fn(() => this.dispatchEvent(new Event('close')));
}

it('keeps heartbeat and expiry in the Worker bridge and releases sockets on cancel, abort and slow consumption', async () => {
  vi.useFakeTimers();
  const open = () => {
    const socket = new BridgeSocket();
    const abort = new AbortController();
    const response = eventStream(socket as unknown as WebSocket, abort.signal);
    return { socket, abort, reader: response.body!.getReader() };
  };
  const streams = [open()];
  const decode = new TextDecoder();
  try {
    const first = streams[0]!;
    expect(decode.decode((await first.reader.read()).value)).toContain('event: ready');
    expect(first.socket.accept).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(15000);
    expect(decode.decode((await first.reader.read()).value)).toBe(': heartbeat\n\n');
    await vi.advanceTimersByTimeAsync(40000);
    while (!(await first.reader.read()).done) { /* Drain queued heartbeats. */ }
    expect(first.socket.close).toHaveBeenCalledOnce();
    const cancelled = open(); streams.push(cancelled);
    await cancelled.reader.cancel();
    expect(cancelled.socket.close).toHaveBeenCalledOnce();
    const aborted = open(); streams.push(aborted);
    await aborted.reader.read(); aborted.abort.abort();
    expect((await aborted.reader.read()).done).toBe(true);
    const slow = open(); streams.push(slow);
    slow.socket.dispatchEvent(new MessageEvent('message', { data: 'x'.repeat(65536) }));
    expect(decode.decode((await slow.reader.read()).value)).toContain('event: ready');
    expect((await slow.reader.read()).done).toBe(true);
    expect(slow.socket.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await Promise.all(streams.map(stream => stream.reader.cancel()));
    vi.useRealTimers();
  }
});

it('forwards frames and closes on errors, invalid messages and already-aborted requests', async () => {
  vi.useFakeTimers();
  try {
    for (const failure of ['error', 'close', 'invalid', 'aborted', 'accept']) {
      const socket = new BridgeSocket();
      const abort = new AbortController();
      if (failure === 'aborted') abort.abort();
      if (failure === 'accept') socket.accept.mockImplementation(() => { throw new Error('closed'); });
      const response = eventStream(socket as unknown as WebSocket, abort.signal);
      const reader = response.body!.getReader();
      await reader.read();
      if (!['aborted', 'accept'].includes(failure)) {
        socket.dispatchEvent(new MessageEvent('message', { data: 'event: example\ndata: {}\n\n' }));
        expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: example');
        socket.dispatchEvent(failure === 'invalid' ? new MessageEvent('message', { data: new ArrayBuffer(1) }) : new Event(failure));
      }
      expect((await reader.read()).done).toBe(true);
      expect(socket.close).toHaveBeenCalledOnce();
    }
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
