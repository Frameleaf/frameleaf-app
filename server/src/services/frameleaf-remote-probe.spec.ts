import { EventEmitter } from 'node:events';
import tls from 'node:tls';
import { FrameleafRemoteAccessService } from 'src/services/frameleaf-remote-access.service.js';
import { newTestService } from 'test/utils.js';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const setup = () => {
  vi.useFakeTimers();
  const events = new EventEmitter();
  let idle: ReturnType<typeof setTimeout> | undefined;
  let idleCallback: (() => void) | undefined;
  let idleMs = 0;
  const socket = Object.assign(events, {
    setTimeout: vi.fn((ms: number, callback: () => void) => {
      idleCallback = callback;
      idleMs = ms;
      idle = setTimeout(callback, ms);
    }),
    destroy: vi.fn(() => {
      clearTimeout(idle);
      events.emit('close');
    }),
    getPeerCertificate: vi.fn().mockReturnValue({ subjectaltname: 'DNS:self.test' }),
    write: vi.fn(),
  });
  events.on('data', () => {
    if (idleCallback) {
      clearTimeout(idle);
      idle = setTimeout(idleCallback, idleMs);
    }
  });
  vi.spyOn(tls, 'connect').mockReturnValue(socket as never);
  vi.spyOn(tls, 'checkServerIdentity').mockReturnValue(undefined);
  const { sut } = newTestService(FrameleafRemoteAccessService);
  const probe = () =>
    (
      sut as unknown as {
        probeEdge: (host: string, port: number, name: string) => Promise<{ ok: boolean; detail: string }>;
      }
    ).probeEdge('127.0.0.1', 4443, 'self.test');
  return { socket, probe };
};

it.each(['stalled', 'trickling'] as const)('ends a %s self-check at the fixed five-second deadline', async (mode) => {
  const { socket, probe } = setup();
  let result: { ok: boolean; detail: string } | undefined;
  const pending = probe().then((value) => {
    result = value;
  });
  try {
    for (let tick = 0; tick < 4; tick++) {
      await vi.advanceTimersByTimeAsync(1000);
      if (mode === 'trickling') socket.emit('data', Buffer.from('H'));
    }
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    expect(result).toEqual({ ok: false, detail: 'The HTTPS listener did not answer in time.' });
    expect(socket.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    socket.emit('end');
    await pending;
  }
});

it.each(['reply', 'certificate', 'error', 'end', 'close'] as const)('clears the deadline after %s', async (event) => {
  const { socket, probe } = setup();
  if (event === 'certificate') vi.mocked(tls.checkServerIdentity).mockReturnValue(new Error('wrong name'));
  let result: { ok: boolean; detail: string } | undefined;
  const pending = probe().then((value) => {
    result = value;
  });
  try {
    if (event === 'reply' || event === 'certificate') {
      socket.emit('secureConnect');
      if (event === 'reply') socket.emit('data', Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'));
      expect(tls.checkServerIdentity).toHaveBeenCalledWith('self.test', socket.getPeerCertificate());
    } else socket.emit(event, ...(event === 'error' ? [new Error('refused')] : []));
    await Promise.resolve();
    expect(result?.ok).toBe(event === 'reply');
    expect(vi.getTimerCount()).toBe(0);
    expect(socket.destroy).toHaveBeenCalledOnce();
  } finally {
    socket.emit('end');
    await pending;
  }
});
