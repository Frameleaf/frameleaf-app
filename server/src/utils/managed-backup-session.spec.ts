import { backupTransferSchema, readBackupTransfer } from 'src/utils/cloud-backup-transfer.js';
import { backupGrantResponseSchema } from 'src/utils/frameleaf-cloud-backup.js';
import { ManagedBackupAuthorizationError, managedBackupSession } from 'src/utils/managed-backup-session.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';

const initial = () => backupGrantResponseSchema.parse(cloudContractFixture('backup/capability-upload.json'));
const nextGrant = () => {
  const grant = initial();
  grant.capability.credentials.accessKeyId = 'ASIANEXTSYNTHETICKEY';
  return grant;
};

describe('managed backup sessions', () => {
  it('accepts the cross-project fixtures and requires all temporary credential members and format versions', () => {
    for (const operation of ['upload', 'restore', 'prune']) {
      expect(
        backupGrantResponseSchema.parse(cloudContractFixture(`backup/capability-${operation}.json`)).capability
          .operation,
      ).toBe(operation);
    }
    const grant = initial();
    delete (grant.capability.credentials as Partial<typeof grant.capability.credentials>).sessionToken;
    expect(backupGrantResponseSchema.safeParse(grant).success).toBe(false);
    expect(backupGrantResponseSchema.safeParse({ ...initial(), objectFormats: { read: [], write: [] } }).success).toBe(
      false,
    );
    expect(backupGrantResponseSchema.safeParse({ ...initial(), credentials: {} }).success).toBe(false);
  });

  it('renews through several lifetimes using monotonic receipt time despite a changed client wall clock', async () => {
    let clock = 0;
    const renew = vi.fn().mockImplementation(() => Promise.resolve(nextGrant()));
    const get = managedBackupSession(initial(), 'upload', renew, () => clock);
    const date = vi.spyOn(Date, 'now').mockReturnValue(0);
    try {
      await get();
      for (let i = 1; i <= 4; i++) {
        clock = i * 600_000;
        date.mockReturnValue(i % 2 ? Number.MAX_SAFE_INTEGER : 0);
        await get();
      }
      expect(renew).toHaveBeenCalledTimes(4);
    } finally {
      date.mockRestore();
    }
  });

  it('shares one renewal among parallel workers and stale expired-token responses', async () => {
    let finish!: (value: ReturnType<typeof initial>) => void;
    const renew = vi.fn(() => new Promise<ReturnType<typeof initial>>((resolve) => (finish = resolve)));
    const get = managedBackupSession(initial(), 'upload', renew, () => 600_000);
    const oldKey = initial().capability.credentials.accessKeyId;
    const first = get(oldKey);
    const others = [get(oldKey), get(oldKey)];
    await Promise.resolve();
    finish(nextGrant());
    const values = await Promise.all([first, ...others]);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(values.every((value) => value.accessKeyId === nextGrant().capability.credentials.accessKeyId)).toBe(true);
    await get(oldKey);
    expect(renew).toHaveBeenCalledTimes(1);
  });

  it('backs off after unavailable Cloud, preserves no fallback credential, and recovers later', async () => {
    let clock = 0;
    const renew = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue(nextGrant());
    const get = managedBackupSession(initial(), 'upload', renew, () => clock);
    clock = 600_000;
    await expect(get()).rejects.toBeInstanceOf(ManagedBackupAuthorizationError);
    await expect(get()).rejects.toBeInstanceOf(ManagedBackupAuthorizationError);
    expect(renew).toHaveBeenCalledTimes(1);
    clock += 60_000;
    await expect(get()).resolves.toEqual(nextGrant().capability.credentials);
  });

  it.each(['operation', 'binding', 'readOnly', 'coverage'])(
    'refuses %s changes without widening operation authority',
    async (change) => {
      const next = nextGrant();
      switch (change) {
        case 'operation': {
          next.capability.operation = 'prune';
          break;
        }
        case 'binding': {
          next.bucket = 'fl-eu-0192f1a4-7c3e-7b21-9d4e-2a6f8c0b1e54';
          break;
        }
        case 'readOnly': {
          next.readOnly = true;
          break;
        }
        case 'coverage': {
          next.coverage = { scope: 'none' };
          break;
        }
      }
      const get = managedBackupSession(initial(), 'upload', () => Promise.resolve(next));
      await expect(get(initial().capability.credentials.accessKeyId)).rejects.toBeInstanceOf(
        ManagedBackupAuthorizationError,
      );
    },
  );

  it('allows read-only retained restore while refusing read-only upload', async () => {
    const grant = initial();
    grant.readOnly = true;
    expect(() => managedBackupSession(grant, 'upload', () => Promise.resolve(grant))).toThrow(
      ManagedBackupAuthorizationError,
    );
    grant.capability.operation = 'restore';
    await expect(managedBackupSession(grant, 'restore', () => Promise.resolve(grant))()).resolves.toEqual(
      grant.capability.credentials,
    );
  });

  it('accepts only bounded nonsecret transfer receipts', () => {
    const state = {
      kind: 'upload',
      key: 'o/hash',
      source: null,
      sourceStamp: null,
      expectedSha256: null,
      uploadId: 'upload-1',
      previousUploads: [],
      parts: [],
      completing: false,
    };
    expect(readBackupTransfer({ backupTransfer: state })).toEqual(state);
    expect(backupTransferSchema.safeParse({ ...state, credentials: initial().capability.credentials }).success).toBe(
      false,
    );
    expect(
      readBackupTransfer({ backupTransfer: { ...state, parts: Array.from({ length: 10_001 }, () => ({})) } }),
    ).toBeNull();
  });
});
