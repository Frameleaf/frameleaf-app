import type { Server } from 'socket.io';
import { defaults } from 'src/dtos/config.dto.js';
import { withSocketConfigUpdate } from 'src/middleware/websocket.adapter.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';

vi.mock('src/middleware/websocket.adapter.js', () => ({
  withSocketPublication: (_server: unknown, action: (workerId: string) => unknown) =>
    Promise.resolve(action('receiver')),
  withSocketConfigUpdate: vi.fn(),
}));

describe('configuration reconciliation acknowledgements', () => {
  const update = { oldConfig: defaults, newConfig: defaults };
  const publication = {
    kind: 'frameleaf-config-reconciliation-v1',
    publicationId: 'publication',
    publisherWorkerId: 'publisher',
  };
  const setup = (onEvent: ReturnType<typeof vi.fn>) => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const repo = new WebsocketRepository(
      { onEvent } as unknown as EventRepository,
      { setContext: vi.fn(), log: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as LoggingRepository,
    );
    const server = {
      on: (event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener),
    } as unknown as Server;
    Reflect.set(repo, 'server', server);
    repo.afterInit(server);
    return listeners.get('ConfigUpdate')!;
  };

  it('acknowledges only after every remote event handler finishes', async () => {
    let finish!: () => void;
    const onEvent = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const receive = setup(onEvent);
    const ack = vi.fn();
    receive(update, publication, ack);
    expect(onEvent).toHaveBeenCalledWith({ name: 'ConfigUpdate', args: [update], server: true });
    expect(ack).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(ack).toHaveBeenCalledWith({ ...publication, workerId: 'receiver', result: 'ok' }));
  });

  it('returns a failure acknowledgement after a rejected remote handler', async () => {
    const receive = setup(vi.fn().mockRejectedValue(new Error('fixture handler failed')));
    const ack = vi.fn();
    receive(update, publication, ack);
    await vi.waitFor(() => expect(ack).toHaveBeenCalledWith({ ...publication, workerId: 'receiver', result: 'error' }));
  });
  it.each([
    { workers: [] },
    { workers: ['A'] },
    { workers: ['B', 'C'] },
    { workers: ['A', 'A'] },
    { workers: ['A', 'B'], result: 'error' },
    { workers: ['A', 'B'], publicationId: 'stale-publication' },
    { workers: ['A', 'B'], publisherWorkerId: 'other-publisher' },
    { workers: ['A', 'B'], legacy: true },
  ])('refuses missing distinct worker or mismatched publication $workers $result', async (fixture) => {
    const server = {
      serverSideEmitWithAck: vi.fn(async (_event, _update, publication) => {
        await Promise.resolve();
        return fixture.workers.map((workerId) =>
          fixture.legacy ? 'ok' : { ...publication, ...fixture, workerId, result: fixture.result ?? 'ok' },
        );
      }),
    } as unknown as Server;
    const repo = new WebsocketRepository(
      {} as EventRepository,
      { setContext: vi.fn() } as unknown as LoggingRepository,
    );
    Reflect.set(repo, 'server', server);
    vi.mocked(withSocketConfigUpdate).mockImplementation(async (_server, action) => action(['A', 'B'], 'publisher'));
    await expect(repo.awaitConfigUpdate(update)).rejects.toThrow('failed configuration reconciliation');
  });

  it('accepts every expected worker only for the current publication, with extra peers unable to replace them', async () => {
    const server = {
      serverSideEmitWithAck: vi.fn(async (_event, _update, publication) => {
        await Promise.resolve();
        return ['B', 'new-peer', 'A'].map((workerId) => ({ ...publication, workerId, result: 'ok' }));
      }),
    } as unknown as Server;
    const repo = new WebsocketRepository(
      {} as EventRepository,
      { setContext: vi.fn() } as unknown as LoggingRepository,
    );
    Reflect.set(repo, 'server', server);
    vi.mocked(withSocketConfigUpdate).mockImplementation(async (_server, action) => action(['A', 'B'], 'publisher'));
    await expect(repo.awaitConfigUpdate(update)).resolves.toBeUndefined();
  });
});
