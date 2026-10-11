import { createAdapter } from '@socket.io/postgres-adapter';
import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Pool } from 'pg';
import { Server } from 'socket.io';
import {
  BACKUP_KEY_REQUEST_LIFETIME_MS,
  CloudBackupKeyChannel,
  loadBackupWorkerIdentity,
} from 'src/utils/cloud-backup-key-channel.js';
import { keyFingerprint, recoveryCode } from 'src/utils/cloud-backup.js';

const identity = generateKeyPairSync('ed25519').privateKey;
const key = Buffer.from('synthetic-backup-secret-32-bytes');
const binding = {
  instanceId: 'instance-a',
  bucketRef: 'https://storage.example/bucket',
  keyFingerprint: keyFingerprint(key),
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
    for (const item of channels.splice(0)) item.close();
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

  it.each([8000, 1])(
    'keeps sentinel key encodings out of real adapter queries and fallback attachments (threshold %i)',
    async (payloadThreshold) => {
      const holder = owner();
      const recipient = channel('recipient');
      const request = await recipient.request(binding);
      const share = await holder.share(request, binding);
      const client = Object.assign(new EventEmitter(), {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn(),
      });
      const query = vi.fn().mockResolvedValue({ rows: [{ id: 1 }] });
      const pool = { query, connect: () => Promise.resolve(client) } as unknown as Pool;
      const errors = vi.fn();
      const io = new Server({ adapter: createAdapter(pool, { payloadThreshold, errorHandler: errors }) });
      try {
        await io.sockets.adapter.init();
        // Exercise exactly the server-side publication used by WebsocketRepository, with the installed
        // PostgreSQL adapter. Capture NOTIFY strings and msgpack attachment bytes before any persistence.
        await io.sockets.adapter.serverSideEmit(['CloudBackupKeyRequest', request]);
        await io.sockets.adapter.serverSideEmit(['CloudBackupKeyShare', share]);
        expect(errors).not.toHaveBeenCalled();
        const publications = query.mock.calls.filter(([sql]) => /pg_notify|INSERT INTO/.test(String(sql)));
        expect(publications.length).toBeGreaterThanOrEqual(2);
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
          for (const sentinel of [
            key,
            Buffer.from(key.toString('base64')),
            Buffer.from(key.toString('hex')),
            Buffer.from(key.toString('base64url')),
            Buffer.from(recoveryCode(key)),
            Buffer.from(JSON.stringify([...key])),
          ]) {
            expect(captured.includes(sentinel)).toBe(false);
          }
        }
        // A LISTEN client has this exact ciphertext, but only the live recipient can open it.
        expect(await channel('database-listener').accept(share, binding)).toBe(false);
        expect(await recipient.accept(share, binding)).toBe(true);
      } finally {
        io.sockets.adapter.close();
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
