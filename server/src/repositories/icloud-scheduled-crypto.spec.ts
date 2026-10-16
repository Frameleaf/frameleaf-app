import type { Kysely } from 'kysely';
import {
  ICloudScheduledStagingRepository,
  ScheduledStagingInput,
} from 'src/repositories/icloud-scheduled-staging.repository.js';
import { ICloudTransportRepository } from 'src/repositories/icloud-transport.repository.js';
import { DB } from 'src/schema/index.js';
import { decryptICloudSession } from 'src/utils/icloud-sync.js';

describe('scheduled staging cryptographic admission', () => {
  it('refreshes configuration between operations and preserves authenticated purposes', async () => {
    const transport = new ICloudTransportRepository();
    const keyA = Buffer.alloc(32, 1),
      keyB = Buffer.alloc(32, 2);
    const configuration = vi
      .spyOn(transport as unknown as { configuration: () => Promise<{ key: Buffer }> }, 'configuration')
      .mockResolvedValueOnce({ key: keyA })
      .mockResolvedValue({ key: keyB });
    const first = await transport.withSessionCrypto(async () => {
      const seal = await transport.encodeSession('first-purpose', { version: 1 });
      expect(await transport.decodeSession('first-purpose', seal)).toEqual({ version: 1 });
      await expect(transport.decodeSession('other-purpose', seal)).rejects.toThrow();
      await transport.withSessionCrypto(() => transport.encodeSession('nested-purpose', {}));
      return seal;
    });
    const second = await transport.withSessionCrypto(() => transport.encodeSession('first-purpose', { version: 2 }));
    expect(decryptICloudSession(keyA, 'first-purpose', first)).toEqual({ version: 1 });
    expect(decryptICloudSession(keyB, 'first-purpose', second)).toEqual({ version: 2 });
    expect(configuration).toHaveBeenCalledTimes(2);
    await transport.encodeSession('unscoped', {});
    await transport.encodeSession('unscoped', {});
    expect(configuration).toHaveBeenCalledTimes(4);
  });

  it('isolates concurrent operations and transport instances', async () => {
    const first = new ICloudTransportRepository(),
      other = new ICloudTransportRepository();
    const a = Buffer.alloc(32, 3),
      b = Buffer.alloc(32, 4),
      c = Buffer.alloc(32, 5);
    vi.spyOn(first as unknown as { configuration: () => Promise<{ key: Buffer }> }, 'configuration')
      .mockResolvedValueOnce({ key: a })
      .mockResolvedValueOnce({ key: b });
    vi.spyOn(other as unknown as { configuration: () => Promise<{ key: Buffer }> }, 'configuration').mockResolvedValue({
      key: c,
    });
    const { promise: waiting, resolve: release } = Promise.withResolvers<void>();
    const { promise: entered, resolve: ready } = Promise.withResolvers<void>();
    const pending = first.withSessionCrypto(async () => {
      ready();
      await waiting;
      return first.encodeSession('scope', { first: true });
    });
    await entered;
    let concurrent: string, independent: string;
    try {
      concurrent = await first.withSessionCrypto(() => first.encodeSession('scope', { concurrent: true }));
      independent = await first.withSessionCrypto(() => other.encodeSession('scope', { independent: true }));
    } finally {
      release();
    }
    expect(decryptICloudSession(a, 'scope', await pending)).toEqual({ first: true });
    expect(decryptICloudSession(b, 'scope', concurrent)).toEqual({ concurrent: true });
    expect(decryptICloudSession(c, 'scope', independent)).toEqual({ independent: true });
  });

  it('keeps configuration failure local to crypto use and retries on the next operation', async () => {
    const transport = new ICloudTransportRepository();
    const error = new Error('configuration unavailable');
    const configuration = vi
      .spyOn(transport as unknown as { configuration: () => Promise<{ key: Buffer }> }, 'configuration')
      .mockRejectedValueOnce(error)
      .mockResolvedValue({ key: Buffer.alloc(32, 6) });
    await expect(
      transport.withSessionCrypto(async () => {
        await expect(transport.encodeSession('scope', {})).rejects.toBe(error);
        return 'ordinary cleanup still permitted';
      }),
    ).resolves.toBe('ordinary cleanup still permitted');
    await expect(transport.withSessionCrypto(() => transport.encodeSession('scope', {}))).resolves.toEqual(
      expect.any(String),
    );
    expect(configuration).toHaveBeenCalledTimes(2);
  });

  it('prepares configuration before the refused-byte release transaction', async () => {
    const transport = new ICloudTransportRepository();
    let locked = false;
    const configuration = vi
      .spyOn(transport as unknown as { configuration: () => Promise<{ key: Buffer }> }, 'configuration')
      .mockImplementation(() => {
        expect(locked).toBe(false);
        return Promise.resolve({ key: Buffer.alloc(32, 7) });
      });
    const db = {
      transaction: () => ({
        execute: async () => {
          locked = true;
          try {
            const seal = await transport.encodeSession('custody-fixture', { retained: true });
            expect(await transport.decodeSession('custody-fixture', seal)).toEqual({ retained: true });
          } finally {
            locked = false;
          }
        },
      }),
    } as unknown as Kysely<DB>;
    await new ICloudScheduledStagingRepository(db, transport).releaseRefusedBytes({} as ScheduledStagingInput);
    expect(configuration).toHaveBeenCalledOnce();
  });
});
