// This bridge runs in the ordinary Worker, never inside the Durable Object.
// Keeping its SSE/timers here lets the DO's incoming WebSocket hibernate.
export const EVENT_STREAM_MS = 55_000;
const encoder = new TextEncoder();

export function eventStream(socket: WebSocket, signal: AbortSignal): Response {
  let close = () => {};
  let closedSocket = () => {};
  let removeSocketListeners = () => {};
  const socketClosed = new Promise<void>(resolve => { closedSocket = resolve; });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let ended = false;
      const send = (message: string) => {
        if (ended) return;
        const bytes = encoder.encode(message);
        if ((controller.desiredSize ?? 0) < bytes.length) { close(); return; }
        try { controller.enqueue(bytes); } catch { close(); }
      };
      const message = (event: MessageEvent) => {
        if (typeof event.data !== 'string') { close(); return; }
        send(event.data);
      };
      const finish = () => {
        closedSocket(); close();
        removeSocketListeners();
      };
      const heartbeat = setInterval(() => send(': heartbeat\n\n'), 15_000);
      const expiry = setTimeout(() => close(), EVENT_STREAM_MS);
      close = () => {
        if (ended) return;
        ended = true;
        clearInterval(heartbeat); clearTimeout(expiry);
        signal.removeEventListener('abort', close);
        socket.removeEventListener('message', message);
        try { controller.close(); } catch { /* Consumer cancelled. */ }
        try { socket.close(1000, 'Stream closed'); } catch { closedSocket(); }
      };
      removeSocketListeners = () => {
        socket.removeEventListener('close', finish);
        socket.removeEventListener('error', finish);
      };
      socket.addEventListener('message', message);
      socket.addEventListener('close', finish, { once: true });
      socket.addEventListener('error', finish, { once: true });
      signal.addEventListener('abort', close, { once: true });
      try { socket.accept(); } catch { finish(); }
      send('retry: 1000\nevent: ready\ndata: {}\n\n');
      if (signal.aborted) close();
    },
    async cancel() {
      close();
      // Let the close handshake release the DO slot before immediate reconnect.
      // This timeout belongs to the Worker, so it cannot prevent DO hibernation.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([socketClosed, new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]);
      clearTimeout(timer);
      removeSocketListeners();
    },
  }, { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength });
  return new Response(body, { headers: {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', 'X-Content-Type-Options': 'nosniff',
  } });
}
