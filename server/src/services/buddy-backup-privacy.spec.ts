import { randomUUID } from 'node:crypto';
import { BuddyBackupPeerService } from 'src/services/buddy-backup-peer.service.js';
import { BuddyBackupRestoreService } from 'src/services/buddy-backup-restore.service.js';
import { createBuddyKeyring } from 'src/utils/buddy-backup-crypto.js';

vi.mock('src/services/base.service.js', () => ({ BaseService: class {} }));

it.each(['read', 'write'] as const)('requests %s access only to this server’s outgoing backup', async (scope) => {
  const local = randomUUID();
  const buddy = randomUUID();
  const incoming = { vaultId: randomUUID(), sourceInstanceId: buddy, destinationInstanceId: local };
  const outgoing = { vaultId: randomUUID(), sourceInstanceId: local, destinationInstanceId: buddy };
  const pairId = randomUUID();
  const cloud = vi.fn().mockResolvedValue({});
  const service = Object.assign(Object.create(BuddyBackupPeerService.prototype), {
    pairing: () => Promise.resolve({ pairId, vaults: [incoming, outgoing] }),
    identity: () => Promise.resolve({ instanceId: local }),
    cloud,
  });
  vi.stubEnv('FRAMELEAF_BUDDY_BACKUP', 'true');
  try {
    await service.grant(scope);
    expect(cloud).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'grants', {
      version: 1,
      pairId,
      vaultId: outgoing.vaultId,
      scope,
    });
  } finally {
    vi.unstubAllEnvs();
  }
});

it('rejects a hosted buddy snapshot before reading or exposing any encrypted content', async () => {
  const ring = createBuddyKeyring(randomUUID());
  const snapshotId = randomUUID();
  const request = vi.fn((_method: string, path: string) =>
    Promise.resolve(
      path === 'snapshots'
        ? [{ id: snapshotId, sequence: 1 }]
        : { snapshot: { version: 1, id: snapshotId, vaultId: randomUUID(), sequence: 1, objects: [] } },
    ),
  );
  const client = vi.fn().mockResolvedValue({ request });
  const service = Object.assign(Object.create(BuddyBackupRestoreService.prototype), {
    backup: { client, keyring: () => Promise.resolve(ring) },
    repository: { state: () => Promise.resolve({ lastSequence: 0 }) },
  });

  await expect(service.open(snapshotId)).rejects.toThrow('Invalid Buddy recovery snapshot');
  expect(client).toHaveBeenCalledExactlyOnceWith('read');
  expect(request.mock.calls).toEqual([
    ['GET', 'snapshots'],
    ['GET', `snapshots/${snapshotId}`],
  ]);
});
