import { PostgresAdapter, createAdapter } from '@socket.io/postgres-adapter';
import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Pool } from 'pg';
import { Server } from 'socket.io';
import { addClientBackupKeys, rotateClientBackupKeys } from 'src/utils/cloud-backup-crypto.js';
import {
  BACKUP_KEY_REQUEST_LIFETIME_MS,
  CloudBackupKeyChannel,
  loadBackupWorkerIdentity,
} from 'src/utils/cloud-backup-key-channel.js';
import { keyFingerprint, recoveryCode } from 'src/utils/cloud-backup.js';

const identity = generateKeyPairSync('ed25519').privateKey;
const key = Buffer.from('synthetic-backup-secret-32-bytes');
const binding = {
  instanceId: 'f0000000-0000-4000-8000-000000000001',
  bucketRef: 'https://storage.example/bucket',
  keyFingerprint: keyFingerprint(key),
};
const recoveryFile = () => {
  const file = addClientBackupKeys({ key: key.toString('base64'), instanceId: binding.instanceId });
  return { ...file, client: rotateClientBackupKeys(file.client, key) };
};

describe(CloudBackupKeyChannel.name, () => {
  const channels: CloudBackupKeyChannel[] = [];
  const channel = (workerId: string, root = identity) => {
    const result = new CloudBackupKeyChannel(workerId, () => Promise.resolve(root));
    channels.push(result);
    return result;
  };
  const owner = () => {
    const result = channel('owner');
    result.setKey(binding, key);
    return result;
  };
  afterEach(() => {
    for (const item of channels) item.close();
    channels.length = 0;
    vi.useRealTimers();
  });

  it('delivers only to the authenticated recipient, including several workers and a restarted worker', async () => {
    const holder = owner();
    await Promise.all(
      ['api-1', 'worker-1', 'worker-2'].map(async (id) => {
        const recipient = channel(id);
        const request = await recipient.request(binding);
        const share = await holder.share(request, binding);
        expect(share).toBeTruthy();
        expect(await channel('listener').accept(share, binding)).toBe(false);
        expect(await recipient.accept(share, binding)).toBe(true);
        expect(recipient.getKey(binding)).toEqual(key);
      }),
    );
    holder.close();
    const survivor = channels.find((item) => item.getKey(binding))!;
    const restarted = channel('owner-restarted');
    const share = await survivor.share(await restarted.request(binding), binding);
    expect(await restarted.accept(share, binding)).toBe(true);
  });

  it('rejects plaintext shares, unsolicited responses and unsigned or altered requests', async () => {
    const holder = owner();
    const recipient = channel('recipient');
    expect(await recipient.accept({ key: key.toString('base64') }, binding)).toBe(false);
    expect(await holder.share({}, binding)).toBeNull();
    const request = (await recipient.request(binding))!;
    expect(await holder.share({ ...request, signature: 'A'.repeat(86) }, binding)).toBeNull();
    expect(await holder.share({ ...request, workerId: 'attacker' }, binding)).toBeNull();
    const attacker = channel('attacker');
    const forged = (await attacker.request(binding))!;
    expect(await holder.share({ ...request, publicKey: forged.publicKey }, binding)).toBeNull();
    const share = (await holder.share(request, binding))!;
    expect(await channel('no-request').accept(share, binding)).toBe(false);
    expect(await recipient.accept({ ...share, ciphertext: 'A'.repeat(43) }, binding)).toBe(false);
    expect(await recipient.accept(share, binding)).toBe(true);
  });

  it('carries independent historical CSE roots only inside a recipient-encrypted reply', async () => {
    const holder = owner();
    const recipient = channel('client-recipient');
    const material = Buffer.from(JSON.stringify(recoveryFile()));
    holder.setKey(binding, key, holder.revision, material);
    const share = (await holder.share(await recipient.request(binding), binding))!;
    expect(share.version).toBe(2);
    expect(JSON.stringify(share)).not.toContain(material.toString());
    expect(await channel('client-listener').accept(share, binding)).toBe(false);
    expect(await recipient.accept(share, binding)).toBe(true);
    expect(recipient.getRecovery(binding)).toEqual(material);
    const owned = recipient.getRecovery(binding)!;
    recipient.setKey(binding, key);
    expect(owned).toEqual(Buffer.alloc(material.length));
    expect(recipient.getRecovery(binding)).toEqual(material);
    const replacement = recipient.getRecovery(binding)!;
    recipient.clear();
    expect(replacement).toEqual(Buffer.alloc(material.length));
    expect(JSON.parse(material.toString()).client.current).toBe(2);
  });

  it('rejects invalid recovery before installation and wipes the exact decrypted buffers', async () => {
    const holder = owner();
    holder.setKey(binding, key, holder.revision, Buffer.from(JSON.stringify(recoveryFile())));
    const recipient = channel('recipient');
    const share = await holder.share(await recipient.request(binding), binding);
    let capturedKey!: Buffer;
    let capturedRecovery!: Buffer;
    expect(
      await recipient.accept(share, binding, (key, recovery) => {
        capturedKey = key;
        capturedRecovery = recovery!;
        throw new Error('Invalid recovery authority');
      }),
    ).toBe(false);
    expect(recipient.getKey(binding)).toBeNull();
    expect(recipient.getRecovery(binding)).toBeNull();
    expect(capturedKey).toEqual(Buffer.alloc(capturedKey.length));
    expect(capturedRecovery).toEqual(Buffer.alloc(capturedRecovery.length));
  });

  it('authenticates expiring version hints without disclosing or installing recovery material', async () => {
    vi.useFakeTimers();
    const holder = owner();
    const recipient = channel('recipient');
    const update = (await holder.update(binding, 2))!;
    expect(Object.keys(update).sort()).toEqual(
      [
        'version',
        'instanceId',
        'bucketRef',
        'keyFingerprint',
        'updateId',
        'workerId',
        'issuedAt',
        'keyVersion',
        'signature',
      ].sort(),
    );
    expect(await recipient.acceptUpdate({ ...update, keyVersion: 3 }, binding)).toBeNull();
    expect(await recipient.acceptUpdate(update, { ...binding, bucketRef: 'other' })).toBeNull();
    expect(
      await channel('stranger', generateKeyPairSync('ed25519').privateKey).acceptUpdate(update, binding),
    ).toBeNull();
    expect(await recipient.acceptUpdate(update, binding)).toBe(2);
    expect(recipient.getKey(binding)).toBeNull();
    expect(await recipient.acceptUpdate(update, binding)).toBeNull();
    const expired = await holder.update(binding, 3);
    await vi.advanceTimersByTimeAsync(BACKUP_KEY_REQUEST_LIFETIME_MS);
    expect(await recipient.acceptUpdate(expired, binding)).toBeNull();
  });

  it('binds minimum-version refreshes and rejects responses to replaced discovery recipients', async () => {
    const holder = owner();
    const recipient = channel('recipient');
    const bootstrap = await recipient.request(binding);
    const oldReply = await holder.share(bootstrap, binding);
    const refresh = (await recipient.request(binding, 2))!;
    expect(refresh).toMatchObject({ version: 2, keyVersion: 2 });
    expect(await holder.share({ ...refresh, keyVersion: 1 }, binding)).toBeNull();
    expect(await recipient.accept(oldReply, binding)).toBe(false);
    expect(await recipient.accept(await holder.share(refresh, binding), binding)).toBe(false);
    const file = recoveryFile();
    holder.setKey(binding, key, holder.revision, Buffer.from(JSON.stringify(file)));
    // Replaying a request to a holder remains forbidden, even after it installs newer material.
    expect(await holder.share(refresh, binding)).toBeNull();
    recipient.clear();
    recipient.setKey(binding, key);
    const required = await recipient.request(binding, 2);
    const share = await holder.share(required, binding);
    expect(
      await recipient.accept(share, binding, (_key, recovery, minimumVersion) => {
        expect(minimumVersion).toBe(2);
        if (JSON.parse(recovery!.toString()).client.current < minimumVersion) throw new Error('Outdated roots');
      }),
    ).toBe(true);
    expect(recipient.getRecovery(binding)).toEqual(Buffer.from(JSON.stringify(file)));
  });

  it('keeps a valid version hint across a concurrent key installation but publishes none across a lock', async () => {
    let release!: (value: typeof identity) => void;
    const slow = new CloudBackupKeyChannel('slow', () => new Promise((done) => (release = done)));
    channels.push(slow);
    const holder = owner();
    const accepting = slow.acceptUpdate(await holder.update(binding, 2), binding);
    slow.setKey(binding, key);
    release(identity);
    expect(await accepting).toBe(2);
    const publishing = slow.update(binding, 2);
    slow.clear();
    release(identity);
    expect(await publishing).toBeNull();
  });

  it('retains a newer local CSE unlock when an older authenticated reply finishes its identity read', async () => {
    let release!: (value: typeof identity) => void;
    let slow = false;
    const recipient = new CloudBackupKeyChannel('recipient', () =>
      slow ? new Promise((done) => (release = done)) : Promise.resolve(identity),
    );
    channels.push(recipient);
    const holder = owner();
    const old = recoveryFile();
    holder.setKey(binding, key, holder.revision, Buffer.from(JSON.stringify(old)));
    const share = await holder.share(await recipient.request(binding), binding);
    slow = true;
    const accepting = recipient.accept(share, binding);
    const current = Buffer.from(JSON.stringify({ ...old, client: rotateClientBackupKeys(old.client, key) }));
    recipient.setKey(binding, key, recipient.revision, current);
    release(identity);
    expect(await accepting).toBe(false);
    expect(recipient.getRecovery(binding)).toEqual(current);
  });

  it('rejects a different identity root, instance or bucket even with the same display fingerprint', async () => {
    const holder = owner();
    const stranger = channel('stranger', generateKeyPairSync('ed25519').privateKey);
    expect(await holder.share(await stranger.request(binding), binding)).toBeNull();
    const recipient = channel('recipient');
    expect(await holder.share(await recipient.request({ ...binding, instanceId: 'instance-b' }), binding)).toBeNull();
    expect(await holder.share(await recipient.request({ ...binding, bucketRef: 'other-bucket' }), binding)).toBeNull();
    recipient.clear();
    const request = await recipient.request(binding);
    const strangerHolder = channel('stranger-holder', generateKeyPairSync('ed25519').privateKey);
    strangerHolder.setKey(binding, key);
    expect(await recipient.accept(await strangerHolder.share(request, binding), binding)).toBe(false);
  });

  it('rejects request and response replays and responses to an expired or replaced recipient', async () => {
    vi.useFakeTimers();
    const holder = owner();
    const recipient = channel('recipient');
    const request = await recipient.request(binding);
    const share = await holder.share(request, binding);
    expect(await holder.share(request, binding)).toBeNull();
    expect(await recipient.accept(share, binding)).toBe(true);
    expect(await recipient.accept(share, binding)).toBe(false);
    recipient.clear();
    const expired = await recipient.request(binding);
    const expiredShare = await holder.share(expired, binding);
    await vi.advanceTimersByTimeAsync(BACKUP_KEY_REQUEST_LIFETIME_MS);
    expect(await recipient.accept(expiredShare, binding)).toBe(false);
    expect(await holder.share(expired, binding)).toBeNull();
    const next = await recipient.request(binding);
    expect(await recipient.accept(expiredShare, binding)).toBe(false);
    expect(await recipient.accept(await holder.share(next, binding), binding)).toBe(true);
  });

  it('overwrites owned root buffers on replacement, lock and shutdown and cannot reacquire after close', async () => {
    const holder = owner();
    const first = holder.getKey(binding)!;
    holder.setKey(binding, key);
    expect(first).toEqual(Buffer.alloc(32));
    const second = holder.getKey(binding)!;
    holder.clear();
    expect(second).toEqual(Buffer.alloc(32));
    const recipient = channel('recipient');
    holder.setKey(binding, key);
    const request = await recipient.request(binding);
    const share = await holder.share(request, binding);
    recipient.clear();
    expect(await recipient.accept(share, binding)).toBe(false);
    const final = holder.getKey(binding)!;
    holder.close();
    expect(final).toEqual(Buffer.alloc(32));
    expect(await holder.request(binding)).toBeNull();
    expect(await holder.share(request, binding)).toBeNull();
    expect(() => holder.setKey(binding, key)).toThrow('closed');
  });

  it('coalesces discovery without invalidating a local unlock, and rejects installation across a lock', async () => {
    const recipient = channel('recipient');
    const revision = recipient.revision;
    const requests = await Promise.all([recipient.request(binding), recipient.request(binding)]);
    expect(requests.filter(Boolean)).toHaveLength(1);
    expect(recipient.revision).toBe(revision);
    expect(recipient.setKey(binding, key, revision)).toBe(true);
    const owned = recipient.getKey(binding)!;
    expect(recipient.getKey({ ...binding, bucketRef: 'older-bucket' })).toBeNull();
    expect(owned).toEqual(key);
    const beforeLock = recipient.revision;
    recipient.clear();
    expect(recipient.setKey(binding, key, beforeLock)).toBe(false);
    expect(recipient.getKey(binding)).toBeNull();
  });

  it('does not publish a request or response after a lock races the identity read', async () => {
    let resolve!: (value: typeof identity) => void;
    const slow = new CloudBackupKeyChannel('slow', () => new Promise((done) => (resolve = done)));
    channels.push(slow);
    const requesting = slow.request(binding);
    slow.clear();
    resolve(identity);
    expect(await requesting).toBeNull();
    slow.setKey(binding, key);
    const request = await channel('recipient').request(binding);
    const sharing = slow.share(request, binding);
    slow.clear();
    resolve(identity);
    expect(await sharing).toBeNull();
  });

  it('cannot replace a newer binding or minimum-version request when an old identity read completes', async () => {
    const reads: Array<(value: typeof identity) => void> = [];
    const recipient = new CloudBackupKeyChannel(
      'recipient',
      () =>
        new Promise((done) => {
          reads.push(done);
        }),
    );
    channels.push(recipient);
    const old = recipient.request(binding, 2);
    expect(await recipient.request(binding, 1)).toBeNull();
    const nextBinding = { ...binding, bucketRef: 'https://storage.example/new-bucket' };
    const next = recipient.request(nextBinding);
    reads[1](identity);
    const request = await next;
    reads[0](identity);
    expect(await old).toBeNull();
    expect(recipient.hasRequest(nextBinding)).toBe(true);
    expect(recipient.hasRequest(binding)).toBe(false);
    const holder = owner();
    holder.setKey(nextBinding, key);
    const share = await holder.share(request, nextBinding);
    const accepting = recipient.accept(share, nextBinding);
    reads[2](identity);
    expect(await accepting).toBe(true);
  });

  it.each([8000, 1])(
    'keeps sentinel key encodings out of real adapter queries and fallback attachments (threshold %i)',
    async (payloadThreshold) => {
      const holder = owner();
      const file = recoveryFile();
      const material = Buffer.from(JSON.stringify(file));
      holder.setKey(binding, key, holder.revision, material);
      const recipient = channel('recipient');
      const request = await recipient.request(binding);
      const share = await holder.share(request, binding);
      const update = await holder.update(binding, file.client.current);
      const client = Object.assign(new EventEmitter(), {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn(),
      });
      const query = vi.fn().mockResolvedValue({ rows: [{ id: 1 }] });
      const pool = { query, connect: () => Promise.resolve(client) } as unknown as Pool;
      const errors = vi.fn();
      const io = new Server({ adapter: createAdapter(pool, { payloadThreshold, errorHandler: errors }) });
      const adapter = io.sockets.adapter;
      if (!(adapter instanceof PostgresAdapter)) throw new Error('Expected the installed PostgreSQL adapter');
      try {
        adapter.init();
        // Exercise exactly the server-side publication used by WebsocketRepository, with the installed
        // PostgreSQL adapter. Capture NOTIFY strings and msgpack attachment bytes before any persistence.
        await adapter.serverSideEmit(['CloudBackupKeyRequest', request]);
        await adapter.serverSideEmit(['CloudBackupKeyShare', share]);
        await adapter.serverSideEmit(['CloudBackupKeyUpdate', update]);
        expect(errors).not.toHaveBeenCalled();
        const publications = query.mock.calls.filter(([sql]) => /pg_notify|INSERT INTO/.test(String(sql)));
        expect(publications.length).toBeGreaterThanOrEqual(3);
        if (payloadThreshold === 1)
          expect(publications.some(([sql]) => String(sql).includes('INSERT INTO'))).toBe(true);
        for (const call of publications) {
          const captured = Buffer.concat(
            call.flatMap((argument) =>
              Array.isArray(argument)
                ? argument.map((value) =>
                    value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(String(value)),
                  )
                : [Buffer.from(String(argument))],
            ),
          );
          const roots = [key, ...Object.values(file.client.keys).map((value) => Buffer.from(value, 'base64'))];
          for (const sentinel of [
            material,
            ...roots.flatMap((root) => [
              root,
              Buffer.from(root.toString('base64')),
              Buffer.from(root.toString('hex')),
              Buffer.from(root.toString('base64url')),
              Buffer.from(recoveryCode(root)),
              Buffer.from(JSON.stringify([...root])),
            ]),
          ]) {
            expect(captured.includes(sentinel)).toBe(false);
          }
        }
        // A LISTEN client has this exact ciphertext, but only the live recipient can open it.
        expect(await channel('database-listener').accept(share, binding)).toBe(false);
        expect(await recipient.accept(share, binding)).toBe(true);
        expect(recipient.getRecovery(binding)).toEqual(material);
      } finally {
        adapter.close();
      }
    },
  );
});

describe(loadBackupWorkerIdentity.name, () => {
  let directory: string;
  const identityFile = () => join(directory, 'instance-key.pem');
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'frameleaf-worker-identity-'));
  });
  afterEach(() => rm(directory, { recursive: true, force: true }));

  it('loads the private Ed25519 identity without a database or cloud connection', async () => {
    await writeFile(identityFile(), identity.export({ format: 'pem', type: 'pkcs8' }), {
      mode: 0o600,
    });
    expect((await loadBackupWorkerIdentity(identityFile())).equals(identity)).toBe(true);
  });

  it('refuses a missing, oversized, linked, nonregular or wrong-type identity', async () => {
    const path = identityFile();
    await expect(loadBackupWorkerIdentity(path)).rejects.toThrow();
    await writeFile(path, Buffer.alloc(8193));
    await expect(loadBackupWorkerIdentity(path)).rejects.toThrow('bounded regular');
    await rm(path);
    await writeFile(join(directory, 'private.pem'), identity.export({ format: 'pem', type: 'pkcs8' }));
    await symlink(join(directory, 'private.pem'), path);
    await expect(loadBackupWorkerIdentity(path)).rejects.toThrow();
    await rm(path);
    await mkdir(path);
    await expect(loadBackupWorkerIdentity(path)).rejects.toThrow('bounded regular');
    await rm(path, { recursive: true });
    await writeFile(path, generateKeyPairSync('x25519').privateKey.export({ format: 'pem', type: 'pkcs8' }));
    await expect(loadBackupWorkerIdentity(path)).rejects.toThrow('Ed25519');
  });
});
