import { lookup } from 'node:dns';
import { EventEmitter } from 'node:events';
import { request } from 'node:https';
import type { LookupAddress } from 'node:dns';
import type { RequestOptions } from 'node:https';
import type { LookupFunction } from 'node:net';
import type { BackupLocation } from 'src/utils/frameleaf-cloud-backup.js';
import { probeBackupLocation, publicProbeAddress, selectBackupLocation } from 'src/utils/backup-location-selection.js';

vi.mock('node:dns', () => ({ lookup: vi.fn() }));
vi.mock('node:https', () => ({ request: vi.fn() }));

const location = (id: string, city = 'Washington, DC'): BackupLocation => ({
  locationId: id,
  cityId: 'washington-dc',
  city,
  country: 'United States',
  countryCode: 'US',
  probeUrl: 'https://s3.us-east-1.backup.frameleaf.cloud/',
});

describe('server-side backup location selection', () => {
  afterEach(() => vi.useRealTimers());

  it('ranks median latency independently for duplicate-city endpoints and uses stable IDs for exact ties', async () => {
    const samples: Record<string, number[]> = {
      'loc-01': [1, 90, 100],
      'loc-02': [70, 70, 1000],
      'loc-03': [70, 70, 80],
    };
    const probe = vi.fn((l: BackupLocation) => Promise.resolve(samples[l.locationId].shift()!));
    expect(
      (await selectBackupLocation([location('loc-03'), location('loc-01'), location('loc-02')], probe)).locationId,
    ).toBe('loc-02');
    expect(probe).toHaveBeenCalledTimes(9);
  });

  it('needs two successful samples, ignores failed requests, and fails closed when no location qualifies', async () => {
    const samples: Record<string, (number | null)[]> = { 'loc-01': [1, null, null], 'loc-02': [null, 80, 100] };
    expect(
      (
        await selectBackupLocation([location('loc-01'), location('loc-02')], (l) =>
          Promise.resolve(samples[l.locationId].shift()!),
        )
      ).locationId,
    ).toBe('loc-02');
    await expect(selectBackupLocation([location('loc-01')], () => Promise.resolve(null))).rejects.toThrow(
      'Try setup again',
    );
  });

  it('runs only six candidate tasks at once and gives each request at most 1.5 seconds', async () => {
    vi.useFakeTimers();
    let active = 0;
    let peak = 0;
    const probe = vi.fn(
      (_l: BackupLocation, signal: AbortSignal) =>
        new Promise<null>((resolve) => {
          active++;
          peak = Math.max(peak, active);
          signal.addEventListener(
            'abort',
            () => {
              active--;
              resolve(null);
            },
            { once: true },
          );
        }),
    );
    const result = selectBackupLocation(
      Array.from({ length: 16 }, (_, i) => location(`loc-${String(i + 1).padStart(2, '0')}`)),
      probe,
    ).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(1499);
    expect(probe).toHaveBeenCalledTimes(6);
    await vi.runAllTimersAsync();
    expect(await result).toBeInstanceOf(Error);
    expect(peak).toBe(6);
    expect(active).toBe(0);
  });

  it('returns within the overall 15-second limit even when a probe never settles or ignores cancellation', async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const result = selectBackupLocation([location('loc-01')], () => new Promise(() => {})).catch(
      (error: Error) => error,
    );
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThanOrEqual(15_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a qualifying result when other candidates time out', async () => {
    vi.useFakeTimers();
    const result = selectBackupLocation([location('loc-01'), location('loc-02')], async (l) =>
      l.locationId === 'loc-01' ? 10 : await new Promise<number>(() => {}),
    );
    await vi.runAllTimersAsync();
    expect((await result).locationId).toBe('loc-01');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses unsafe catalog URLs before probing', async () => {
    const probe = vi.fn(() => Promise.resolve(5));
    const insecure = new URL(location('loc-01').probeUrl);
    insecure.protocol = 'http:';
    for (const url of [
      insecure.href,
      'https://localhost/',
      'https://s3.us-east-1.backup.frameleaf.cloud.attacker.test/',
      'https://user:password@s3.us-east-1.backup.frameleaf.cloud/',
      'https://s3.us-east-1.backup.frameleaf.cloud/bucket',
      'https://s3.us-east-1.backup.frameleaf.cloud:8443/',
    ]) {
      await expect(selectBackupLocation([{ ...location('loc-01'), probeUrl: url }], probe)).rejects.toThrow(
        'Try setup again',
      );
    }
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('unauthenticated HTTPS origin probe', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '192.0.2.1',
    '198.18.0.1',
    '224.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
    '2002:7f00:1::',
  ])('refuses nonpublic address %s', (address) => {
    expect(publicProbeAddress(address)).toBe(false);
  });

  it('pins public DNS results into the TLS request, measures the first response, and never follows redirects or sends credentials', async () => {
    vi.mocked(lookup).mockImplementation(((
      _host: string,
      _options: unknown,
      callback: (error: Error | null, addresses: LookupAddress[]) => void,
    ) => callback(null, [{ address: '8.8.8.8', family: 4 }])) as never);
    let options: RequestOptions = {};
    vi.mocked(request).mockImplementation(((
      url: URL,
      supplied: RequestOptions,
      respond: (response: unknown) => void,
    ) => {
      options = supplied;
      expect(url.href).toBe(location('loc-01').probeUrl);
      const req = new EventEmitter() as EventEmitter & { end: () => void };
      req.end = () => {
        (supplied.lookup as LookupFunction)(url.hostname, {}, (error, address, family) => {
          expect(error).toBeNull();
          expect(address).toBe('8.8.8.8');
          expect(family).toBe(4);
          respond({ statusCode: 303, headers: { location: 'https://outside.example/' }, resume: vi.fn() });
        });
      };
      return req;
    }) as never);
    await expect(probeBackupLocation(location('loc-01'), new AbortController().signal)).resolves.toEqual(
      expect.any(Number),
    );
    expect(options).toMatchObject({ method: 'HEAD', agent: false, autoSelectFamily: false, rejectUnauthorized: true });
    expect(options).not.toHaveProperty('headers');
    expect(vi.mocked(request)).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid TLS certificates without exposing provider error text', async () => {
    expect(publicProbeAddress('8.8.8.8')).toBe(true);
    expect(publicProbeAddress('2606:4700:4700::1111')).toBe(true);
    vi.mocked(request).mockImplementation(((_url: URL, _options: unknown, _respond: unknown) => {
      const req = new EventEmitter() as EventEmitter & { end: () => void };
      req.end = () => req.emit('error', new Error('certificate mismatch at upstream provider'));
      return req;
    }) as never);
    await expect(probeBackupLocation(location('loc-01'), new AbortController().signal)).resolves.toBeNull();
  });

  it('rejects the entire DNS response when even one address is nonpublic', async () => {
    vi.mocked(lookup).mockImplementation(((
      _host: string,
      _options: unknown,
      callback: (error: Error | null, addresses: LookupAddress[]) => void,
    ) =>
      callback(null, [
        { address: '8.8.8.8', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ])) as never);
    vi.mocked(request).mockImplementation(((url: URL, supplied: RequestOptions) => {
      const req = new EventEmitter() as EventEmitter & { end: () => void };
      req.end = () => (supplied.lookup as LookupFunction)(url.hostname, {}, (error) => req.emit('error', error));
      return req;
    }) as never);
    await expect(probeBackupLocation(location('loc-01'), new AbortController().signal)).resolves.toBeNull();
  });

  it.each(['DNS', 'response'])(
    'cancels the real probe during stalled %s and ignores late settlement',
    async (phase) => {
      vi.useFakeTimers();
      const signals: AbortSignal[] = [];
      const pending: Promise<number | null>[] = [];
      const lateDns: (() => void)[] = [];
      const lateResponses: (() => void)[] = [];
      const drained = vi.fn();
      vi.mocked(lookup).mockImplementation(((
        _host: string,
        _options: unknown,
        callback: (error: Error | null, addresses: LookupAddress[]) => void,
      ) => {
        const release = () => callback(null, [{ address: '8.8.8.8', family: 4 }]);
        if (phase === 'DNS') {
          lateDns.push(release);
        } else {
          release();
        }
      }) as never);
      vi.mocked(request).mockImplementation(((
        url: URL,
        options: RequestOptions,
        respond: (response: unknown) => void,
      ) => {
        expect(options).toMatchObject({ method: 'HEAD', agent: false, autoSelectFamily: false });
        expect(options).not.toHaveProperty('headers');
        const signal = options.signal!;
        signals.push(signal);
        const req = new EventEmitter() as EventEmitter & { end: () => void };
        // Model Node's request boundary abort notification; actual socket closure remains a hosted-network gate.
        signal.addEventListener('abort', () => req.emit('error', new Error('Request aborted')), { once: true });
        req.end = () => {
          (options.lookup as LookupFunction)(url.hostname, {}, (error, address) => {
            expect(error).toBeNull();
            expect(address).toBe('8.8.8.8');
            lateResponses.push(() => respond({ statusCode: 200, resume: drained }));
          });
        };
        return req;
      }) as never);
      // Observe the real probe promises without substituting the production probe or selection algorithm.
      const result = selectBackupLocation([location('loc-01')], (candidate, signal) => {
        const probe = probeBackupLocation(candidate, signal);
        pending.push(probe);
        return probe;
      }).catch((error: Error) => error);
      await vi.advanceTimersByTimeAsync(1499);
      expect(request).toHaveBeenCalledTimes(1);
      expect(signals[0].aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signals[0].aborted).toBe(true);
      expect(await pending[0]).toBeNull();
      expect(request).toHaveBeenCalledTimes(2);
      await vi.runAllTimersAsync();
      const refusal = await result;
      expect(refusal).toBeInstanceOf(Error);
      expect(String(refusal)).toContain('Try setup again');
      expect(request).toHaveBeenCalledTimes(3);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(await Promise.all(pending)).toEqual([null, null, null]);
      for (const release of lateDns) {
        release();
      }
      for (const respond of lateResponses) {
        respond();
      }
      expect(drained).toHaveBeenCalledTimes(3);
      expect(await Promise.all(pending)).toEqual([null, null, null]);
      expect(await result).toBe(refusal);
      expect(request).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
