import { ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { BuddyBackupPeerController } from 'src/controllers/buddy-backup-peer.controller.js';
import { BuddyBackupPeerService } from 'src/services/buddy-backup-peer.service.js';

vi.mock('src/services/base.service.js', () => ({ BaseService: class {} }));

it('holds both snapshot admission slots through deferred commits and releases them on success or error', async () => {
  const leases = new Map<string, string>();
  const pending = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const started = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  let commits = 0;
  const service = Object.assign(Object.create(BuddyBackupPeerService.prototype), {
    rates: {
      claimUploadStream: (key: string, token: string) => {
        if (leases.has(key)) return Promise.resolve(false);
        leases.set(key, token);
        return Promise.resolve(true);
      },
      releaseUploadStream: (key: string, token: string) => {
        expect(leases.get(key)).toBe(token);
        leases.delete(key);
        return Promise.resolve();
      },
    },
    authorize: () => Promise.resolve({ grant: { exp: Math.floor(Date.now() / 1000) + 300 } }),
    assertAccess: async () => {},
    signed: (_access: unknown, data: unknown) => Promise.resolve(data),
    commit: async () => {
      const index = commits++;
      if (index < 2) {
        started[index].resolve();
        await pending[index].promise;
      }
    },
  });
  const controller = new BuddyBackupPeerController(service);
  const vaultId = randomUUID();
  const response = { setHeader: () => {} } as unknown as Response;
  const request = (onRead = () => {}) =>
    ({
      headers: { 'content-type': 'application/vnd.frameleaf.buddy+json' },
      destroy: () => {},
      *[Symbol.iterator]() {
        onRead();
        yield Buffer.from(JSON.stringify({ snapshot: { id: vaultId, sequence: 1 }, signature: 'test' }));
      },
    }) as unknown as Request;
  const first = controller.commit(vaultId, request(), response);
  const second = controller.commit(vaultId, request(), response);
  const secondFailure = expect(second).rejects.toThrow('commit refused');
  try {
    await Promise.all(started.map(({ promise }) => promise));
    let consumed = false;
    await expect(
      controller.commit(
        vaultId,
        request(() => (consumed = true)),
        response,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(consumed).toBe(false);
    expect(leases.size).toBe(2);
    pending[0].resolve();
    await first;
    await controller.commit(vaultId, request(), response);
    expect(leases.size).toBe(1);
    pending[1].reject(new Error('commit refused'));
    await secondFailure;
    await controller.commit(vaultId, request(), response);
    expect(leases.size).toBe(0);
  } finally {
    pending[0].resolve();
    pending[1].reject(new Error('commit refused'));
    await Promise.allSettled([first, second, secondFailure]);
  }
});
