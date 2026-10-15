import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Response } from 'express';
import type { AddressInfo } from 'node:net';
import { BuddyBackupPeerService } from 'src/services/buddy-backup-peer.service.js';
import { BUDDY_BLOCK_BYTES, BUDDY_SEALED_OVERHEAD } from 'src/utils/buddy-backup-crypto.js';

vi.mock('src/services/base.service.js', () => ({ BaseService: class {} }));

describe(BuddyBackupPeerService.name, () => {
  // Verification downloads whole files; a large file (the database dump) spans several full 8 MiB objects.
  it('streams a full-size object although each write commits before its drain wait begins', async () => {
    const block = randomBytes(BUDDY_BLOCK_BYTES + BUDDY_SEALED_OVERHEAD);
    const service = Object.assign(Object.create(BuddyBackupPeerService.prototype), {
      streamSlot: () => Promise.resolve(() => Promise.resolve()),
      throttle: () => Promise.resolve(),
      signed: () => ({ proof: 'proof' }),
      // Like the real dispatch: the action runs in a locked transaction whose commit takes a moment.
      dispatch: async (_access: unknown, _scope: string, action: () => Promise<unknown>) => {
        const result = await action();
        await sleep(5);
        return result;
      },
    }) as BuddyBackupPeerService;
    const access = { grant: { exp: Math.floor(Date.now() / 1000) + 300 }, vault: { read: () => block } };
    const server = createServer((_request, response) => {
      void service.download(access as never, response as unknown as Response, 'a'.repeat(64)).catch(() => {});
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const answer = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, {
        signal: AbortSignal.timeout(20_000),
      });
      const received = Buffer.from(await answer.arrayBuffer());
      expect(received.equals(block)).toBe(true);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }, 30_000);
});
