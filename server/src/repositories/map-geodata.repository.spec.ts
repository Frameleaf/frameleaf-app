import * as fs from 'node:fs';
import { PassThrough } from 'node:stream';
import { MapRepository } from 'src/repositories/map.repository.js';

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
  createReadStream: vi.fn(),
  existsSync: vi.fn(() => true),
}));

const row = (id: number, feature = 'PPL', country = 'US') =>
  [
    id,
    'City',
    '',
    'Other',
    '12.5',
    '-40',
    '',
    feature,
    country,
    '',
    'A',
    'B',
    '',
    '',
    '',
    '',
    '',
    '',
    '2026-01-01',
  ].join('\t');

const setup = (execute: () => Promise<unknown> = vi.fn(() => Promise.resolve([]))) => {
  const input = new PassThrough();
  vi.mocked(fs.createReadStream).mockReturnValue(input as never);
  const values = vi.fn((_rows: unknown[]) => ({ execute }));
  const insertInto = vi.fn(() => ({ values }));
  const repository = new MapRepository(
    { getEnv: () => ({ resourcePaths: { geodata: { cities500: '/synthetic-cities' } } }) } as never,
    undefined as never,
    { setContext: vi.fn(), log: vi.fn() } as never,
    { insertInto } as never,
  );
  return {
    input,
    values,
    insertInto,
    loadAdmin: () => repository['loadAdmin']('/synthetic-admin'),
    load: () => repository['loadCities500'](new Map([['US.A', 'State']]), new Map([['US.A.B', 'County']])),
  };
};

describe('geodata streaming import', () => {
  it('streams administrative names with last-row precedence', async () => {
    const { input, loadAdmin } = setup();
    const pending = loadAdmin();
    input.end('US.A\tOld\textra\r\nUS.A\tState\textra\r\nUS.B\tOther');
    await expect(pending).resolves.toEqual(
      new Map([
        ['US.A', 'State'],
        ['US.B', 'Other'],
      ]),
    );
    expect(vi.mocked(fs.createReadStream).mock.lastCall?.[1]).toEqual({ highWaterMark: 64 * 1024 });
    expect(input.destroyed).toBe(true);
  });

  it('bounds reads and preserves filtering, row fields and batch size', async () => {
    const { input, values, insertInto, load } = setup();
    const pending = load();
    input.end(
      [
        row(1, 'PPLX'),
        row(2, 'PPLH'),
        row(3, 'PPLX', 'AU'),
        ...Array.from({ length: 5000 }, (_, i) => row(i + 4)),
      ].join('\r\n'),
    );
    await pending;
    expect(vi.mocked(fs.createReadStream).mock.lastCall?.[1]).toEqual({ highWaterMark: 64 * 1024 });
    expect(values.mock.calls.map(([rows]) => rows.length)).toEqual([5000, 1]);
    expect(insertInto).toHaveBeenCalledWith('geodata_places_tmp');
    expect(values.mock.calls[0][0][0]).toMatchObject({ id: 3, countryCode: 'AU', admin1Name: null });
    expect(values.mock.calls[0][0][1]).toEqual({
      id: 4,
      name: 'City',
      alternateNames: 'Other',
      latitude: 12.5,
      longitude: -40,
      countryCode: 'US',
      admin1Code: 'A',
      admin2Code: 'B',
      modificationDate: '2026-01-01',
      admin1Name: 'State',
      admin2Name: 'County',
    });
    expect(input.destroyed).toBe(true);
  });

  it('closes an unfinished input when a database operation throws', async () => {
    const failure = new Error('database unavailable');
    const { input, load } = setup(
      vi.fn(() => {
        throw failure;
      }),
    );
    const pending = load();
    input.write(Array.from({ length: 5000 }, (_, i) => row(i)).join('\n') + '\n');
    await expect(pending).rejects.toBe(failure);
    expect(input.destroyed).toBe(true);
    input.destroy();
  });

  it('propagates asynchronous failure without waiting for input EOF', async () => {
    const failure = new Error('insert rejected');
    const { input, load } = setup(() => Promise.reject(failure));
    const pending = load();
    input.write(Array.from({ length: 5000 }, (_, i) => row(i)).join('\n') + '\n');
    await expect(pending).rejects.toBe(failure);
    expect(input.destroyed).toBe(true);
  });

  it('keeps at most nine inserts in flight', async () => {
    const gate = Promise.withResolvers<void>();
    const execute = vi.fn(() => gate.promise);
    const { input, load } = setup(execute);
    const pending = load();
    input.end(Array.from({ length: 45_001 }, (_, i) => row(i)).join('\n'));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(9));
    expect(execute).toHaveBeenCalledTimes(9);
    gate.resolve();
    await pending;
    expect(execute).toHaveBeenCalledTimes(10);
  });
});
