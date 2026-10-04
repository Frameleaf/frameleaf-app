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
});
