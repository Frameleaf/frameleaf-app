import { Pool } from 'pg';
import type { ConfigRepository } from 'src/repositories/config.repository.js';
import { WORKER_PROOF_TIMEOUT_MS, WorkerStopProofRecorder } from 'src/queue/worker-stop-proof.js';

vi.mock('pg', () => ({ Pool: vi.fn() }));
const config = {
  getEnv: () => ({ database: { config: { connectionType: 'url', url: 'postgres://localhost/frameleaf' } } }),
} as unknown as ConfigRepository;
const proof = { workerId: '9278736b-d61f-4b66-8de9-41d17a5e59ca', stoppedAt: 12_345 };

describe('supervisor stop proof recorder', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('uses one separate bounded connection and retries failed metadata without replaying work', async () => {
    const release = vi.fn();
    const query = vi.fn().mockRejectedValueOnce(new Error('database unavailable')).mockResolvedValue({});
    const connect = vi.fn().mockResolvedValue({ query, release });
    vi.mocked(Pool).mockImplementation(function () {
      return { connect, on: vi.fn(), end: vi.fn().mockResolvedValue(undefined) } as unknown as Pool;
    });
    const diagnostic = vi.fn();
    const recorder = new WorkerStopProofRecorder(config, { retryMs: 50, diagnostic });
    try {
      await recorder.record(proof);
      expect(Pool).toHaveBeenLastCalledWith(
        expect.objectContaining({
          max: 1,
          connectionTimeoutMillis: WORKER_PROOF_TIMEOUT_MS,
          query_timeout: WORKER_PROOF_TIMEOUT_MS,
          statement_timeout: WORKER_PROOF_TIMEOUT_MS,
          lock_timeout: WORKER_PROOF_TIMEOUT_MS,
        }),
      );
      expect(release).toHaveBeenCalledWith(true);
      expect(diagnostic).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(51);
      expect(query).toHaveBeenCalledTimes(2);
      expect(query.mock.calls[0][1]).toEqual([JSON.stringify([proof])]);
      expect(query.mock.calls[1][1]).toEqual(query.mock.calls[0][1]);
      expect(query.mock.calls[1][0]).toContain('public.system_metadata');
      expect(release).toHaveBeenLastCalledWith(false);
      await vi.advanceTimersByTimeAsync(100);
      expect(query).toHaveBeenCalledTimes(2);
    } finally {
      await recorder.close();
    }
  });

  it('republishes the original confirmed proof after metadata replacement and then releases it', async () => {
    const rows = new Map<string, unknown>();
    const query = vi.fn((_sql: string, [payload]: [string]) => {
      for (const value of JSON.parse(payload)) rows.set(value.workerId, value);
      return Promise.resolve({});
    });
    vi.mocked(Pool).mockImplementation(function () {
      return {
        connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
        on: vi.fn(),
        end: vi.fn().mockResolvedValue(undefined),
      } as unknown as Pool;
    });
    const recorder = new WorkerStopProofRecorder(config);
    try {
      await recorder.republish();
      expect(query).not.toHaveBeenCalled(); // A cold supervisor cannot invent stop evidence.
      await recorder.record(proof);
      rows.clear(); // An older dump replaced system_metadata after the successful first write.
      await vi.advanceTimersByTimeAsync(1000);
      await recorder.republish();
      expect(rows.values().toArray()).toEqual([proof]);
      expect(query.mock.calls[1][1]).toEqual([JSON.stringify([proof])]);
      await recorder.republish();
      expect(query).toHaveBeenCalledTimes(2); // Successful bootstrap releases the retained proof.
    } finally {
      await recorder.close();
    }
  });

  it('retries a failed republication without refreshing the confirmed stop time', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('restore connection reset'))
      .mockResolvedValue({});
    const release = vi.fn();
    vi.mocked(Pool).mockImplementation(function () {
      return {
        connect: vi.fn().mockResolvedValue({ query, release }),
        on: vi.fn(),
        end: vi.fn().mockResolvedValue(undefined),
      } as unknown as Pool;
    });
    const recorder = new WorkerStopProofRecorder(config, { retryMs: 50, diagnostic: vi.fn() });
    try {
      await recorder.record(proof);
      await recorder.republish();
      expect(release).toHaveBeenLastCalledWith(true);
      await vi.advanceTimersByTimeAsync(51);
      expect(query).toHaveBeenCalledTimes(3);
      expect(query.mock.calls.every((call) => call[1][0] === JSON.stringify([proof]))).toBe(true);
      await recorder.republish();
      expect(query).toHaveBeenCalledTimes(3);
    } finally {
      await recorder.close();
    }
  });

  it('does not return a concurrently arriving proof before its first write attempt', async () => {
    const { promise: first, resolve: finish } = Promise.withResolvers<void>();
    const query = vi.fn().mockReturnValueOnce(first).mockResolvedValue({});
    const connect = vi.fn().mockResolvedValue({ query, release: vi.fn() });
    vi.mocked(Pool).mockImplementation(function () {
      return { connect, on: vi.fn(), end: vi.fn().mockResolvedValue(undefined) } as unknown as Pool;
    });
    const recorder = new WorkerStopProofRecorder(config);
    const other = { workerId: '05781a21-0a8f-428d-be97-08fc7f219146', stoppedAt: 12_346 };
    try {
      const initial = recorder.record(proof);
      await Promise.resolve();
      const second = recorder.record(other);
      finish();
      await Promise.all([initial, second]);
      expect(query).toHaveBeenCalledTimes(2);
      expect(query.mock.calls[1][1]).toEqual([JSON.stringify([other])]);
    } finally {
      finish();
      await recorder.close();
    }
  });
});
