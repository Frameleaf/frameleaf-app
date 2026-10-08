import { PostgresSocketTransport } from 'src/middleware/websocket.adapter.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';

const fixture = vi.hoisted(() => ({
  query: vi.fn(),
  close: vi.fn(),
  connect: undefined as ((client: unknown) => void) | undefined,
  adapter: { init: vi.fn(), serverCount: vi.fn(), close: vi.fn() },
}));
vi.mock('@socket.io/postgres-adapter', () => ({ createAdapter: vi.fn(() => 'postgres-adapter') }));
vi.mock('src/utils/shared-service-pool.js', () => ({
  createSharedServicePool: () => ({
    query: fixture.query,
    on: (event: string, callback: (client: unknown) => void) => {
      if (event === 'connect') {
        fixture.connect = callback;
      }
    },
  }),
  trackPoolClients: () => new Set(),
  closeSharedServicePool: fixture.close,
}));

describe(PostgresSocketTransport.name, () => {
  const server = () => ({ adapter: vi.fn(), sockets: { adapter: fixture.adapter } }) as never;
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fixture.query.mockResolvedValue({ rows: [{ count: 2 }] });
    fixture.adapter.serverCount.mockResolvedValue(3);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('registers a worker only after PostgreSQL confirms LISTEN, then deregisters and closes', async () => {
    const transport = new PostgresSocketTransport({} as ConfigRepository);
    const io = server();
    const ready = transport.attach(io);
    let listening!: () => void;
    const client = {
      once: vi.fn(),
      query: vi.fn((_text: string) => new Promise<void>((resolve) => (listening = resolve))),
    };
    fixture.connect!(client);
    const listen = client.query('LISTEN "frameleaf-socket.io#/"');
    expect(fixture.query).not.toHaveBeenCalled();
    listening();
    await listen;
    await ready;
    expect(fixture.adapter.init).toHaveBeenCalledOnce();
    expect(fixture.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO public.frameleaf_websocket_worker'),
      [expect.any(String)],
    );
    await transport.close();
    expect(fixture.query).toHaveBeenLastCalledWith(
      expect.stringContaining('DELETE FROM public.frameleaf_websocket_worker WHERE id = $1'),
      [expect.any(String)],
    );
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it('fails readiness finitely and closes resources when PostgreSQL never becomes available', async () => {
    const transport = new PostgresSocketTransport({} as ConfigRepository);
    const ready = transport.attach(server(), false);
    const rejected = expect(ready).rejects.toThrow('LISTEN timed out');
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    await transport.close();
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it('does not accept an empty peer cache while live workers are registered, and holds no client while waiting', async () => {
    const transport = new PostgresSocketTransport({} as ConfigRepository);
    fixture.adapter.serverCount.mockResolvedValue(1);
    const discovery = transport.discoverWorkers(server());
    const rejected = expect(discovery).rejects.toThrow('discovery timed out');
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(fixture.query).toHaveBeenCalledOnce();
    await transport.close();
  });

  it('rejects an empty live-worker registry', async () => {
    const transport = new PostgresSocketTransport({} as ConfigRepository);
    fixture.query.mockResolvedValueOnce({ rows: [{ count: 0 }] });
    await expect(transport.discoverWorkers(server())).rejects.toThrow('No live websocket workers');
    await transport.close();
  });

  it('configuration discovery refuses an unregistered publisher even with no remote peers', async () => {
    const transport = new PostgresSocketTransport({} as ConfigRepository);
    fixture.query.mockResolvedValueOnce({ rows: [{ count: 0, selfLive: false }] });
    await expect(transport.discoverWorkers(server(), true)).rejects.toThrow('not a live registered websocket worker');
    await transport.close();
  });

  it('configuration discovery excludes its registered publisher without requiring a fictitious remote worker', async () => {
    const transport = new PostgresSocketTransport({} as ConfigRepository);
    fixture.query.mockResolvedValueOnce({ rows: [{ count: 0, selfLive: true, workerIds: [] }] });
    fixture.adapter.serverCount.mockResolvedValueOnce(1);
    await expect(transport.discoverWorkers(server(), true)).resolves.toEqual([]);
    expect(fixture.query).toHaveBeenCalledWith(expect.stringContaining('id <> $2'), [true, expect.any(String)]);
    await transport.close();
  });

  it('waits for restart publication instead of returning with an in-flight PostgreSQL message', async () => {
    const transport = new PostgresSocketTransport({} as ConfigRepository);
    let commit!: () => void;
    fixture.query.mockImplementationOnce(() => new Promise<void>((resolve) => (commit = resolve)));
    let finished = false;
    const publication = transport
      .publish(() => {
        void transport.pool.query('SELECT pg_notify($1, $2)', ['channel', 'restart']);
      })
      .then(() => (finished = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(fixture.close).not.toHaveBeenCalled();
    commit();
    await publication;
    expect(finished).toBe(true);
    await transport.close();
  });

  it('reports a publication error even when the adapter swallows its query rejection', async () => {
    const transport = new PostgresSocketTransport({} as ConfigRepository);
    const error = new Error('notify failed');
    fixture.query.mockRejectedValueOnce(error);
    await expect(
      transport.publish(async () => {
        await transport.pool.query('SELECT pg_notify($1, $2)', ['channel', 'restart']).catch(() => {});
      }),
    ).rejects.toBe(error);
    await transport.close();
  });

  it('does not initiate publication after transport shutdown', async () => {
    const transport = new PostgresSocketTransport({} as ConfigRepository);
    await transport.close();
    const action = vi.fn();
    await expect(transport.publish(action)).rejects.toThrow('is stopping');
    expect(action).not.toHaveBeenCalled();
  });
});
