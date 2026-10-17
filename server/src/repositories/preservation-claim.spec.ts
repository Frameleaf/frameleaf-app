import type { Kysely } from 'kysely';
import { PreservationRepository } from 'src/repositories/preservation.repository.js';
import { DB } from 'src/schema/index.js';
import { operationExecution } from 'src/utils/execution-signal.js';
import { OperationClaimLostError } from 'src/utils/operation-execution.js';

describe('preservation final export claim', () => {
  const fixture = () => {
    const read = vi.fn().mockResolvedValueOnce({ id: 'operation' }).mockResolvedValue(undefined);
    const query = { select: vi.fn(), where: vi.fn(), forUpdate: vi.fn(), executeTakeFirst: read };
    query.select.mockReturnValue(query);
    query.where.mockReturnValue(query);
    query.forUpdate.mockReturnValue(query);
    const tx = { selectFrom: vi.fn().mockReturnValue(query) };
    const db = {
      transaction: () => ({ execute: (write: (tx: unknown) => Promise<unknown>) => write(tx) }),
    } as unknown as Kysely<DB>;
    return { sut: new PreservationRepository(db), read };
  };

  it('refuses a claim that is lost before the callback returns', async () => {
    const { sut, read } = fixture();
    const write = vi.fn().mockResolvedValue('tentative');
    await expect(sut.withExportClaim('operation', 'token', write)).rejects.toBeInstanceOf(OperationClaimLostError);
    expect(write).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('returns the callback result only while the claim remains current', async () => {
    const { sut, read } = fixture();
    read.mockResolvedValue({ id: 'operation' });
    await expect(sut.withExportClaim('operation', 'token', () => Promise.resolve('committed'))).resolves.toBe(
      'committed',
    );
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('refuses execution cancellation observed after the callback', async () => {
    const { sut, read } = fixture();
    read.mockResolvedValue({ id: 'operation' });
    const abort = new AbortController();
    const reason = new Error('owner cancelled');
    await expect(
      operationExecution.run(
        {
          signal: abort.signal,
          settled: false,
          completed: new Map(),
          progress: vi.fn(),
          settle: () => Promise.resolve(),
        },
        () =>
          sut.withExportClaim('operation', 'token', () => {
            abort.abort(reason);
            return Promise.resolve('tentative');
          }),
      ),
    ).rejects.toBe(reason);
  });

  it('preserves the original callback failure', async () => {
    const { sut, read } = fixture();
    const error = new Error('write failed');
    await expect(sut.withExportClaim('operation', 'token', () => Promise.reject(error))).rejects.toBe(error);
    expect(read).toHaveBeenCalledOnce();
  });
});
