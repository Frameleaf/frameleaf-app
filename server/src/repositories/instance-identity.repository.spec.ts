import { createPublicKey, generateKeyPairSync, randomBytes, randomUUID, verify } from 'node:crypto';
import {
  type FileHandle,
  access,
  link,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CANDIDATE_KEY_FILE,
  INSTANCE_KEY_FILE,
  InstanceIdentityRepository,
  NEXT_KEY_FILE,
  PROVEN_KEY_FILE,
  RETIRING_KEY_FILE,
  RETIRING_META_FILE,
  ROTATION_NEEDED_FILE,
  SET_ASIDE_MARK,
} from 'src/repositories/instance-identity.repository.js';
import { ed25519Thumbprint } from 'src/utils/frameleaf-cloud.js';

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

/**
 * A `link()` that can fail like it does on SMB/CIFS or FUSE media mounts, a `readFile()` of one named
 * file that can fail like an unreadable (EACCES) or vanished (ENOENT) file, file handles that record
 * every flush (and can fail one, or cut a write short with ENOSPC).
 */
const fsControl = vi.hoisted(() => ({
  linkError: null as string | null,
  chmodError: null as string | null,
  readError: null as { file: string; code: string } | null,
  /** A write to a path containing this is cut short and fails with ENOSPC. */
  writeError: null as string | null,
  /** Paths whose handle was flushed, in order. */
  synced: [] as string[],
  /** Flush failures by path. */
  syncErrors: {} as Record<string, string>,
  /** A close of a handle for a path containing this fails with EIO. */
  closeError: null as string | null,
}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    link: (from: string, to: string) =>
      fsControl.linkError
        ? Promise.reject(Object.assign(new Error('link not supported'), { code: fsControl.linkError }))
        : actual.link(from, to),
    chmod: (path: string, mode: number) =>
      fsControl.chmodError
        ? Promise.reject(Object.assign(new Error('chmod not supported'), { code: fsControl.chmodError }))
        : actual.chmod(path, mode),
    readFile: (path: string, ...rest: unknown[]) =>
      fsControl.readError && path.endsWith(`/${fsControl.readError.file}`)
        ? Promise.reject(Object.assign(new Error('read refused'), { code: fsControl.readError.code }))
        : Reflect.apply(actual.readFile, undefined, [path, ...rest]),
    open: async (path: string, ...rest: unknown[]) => {
      const handle: FileHandle = await Reflect.apply(actual.open, undefined, [path, ...rest]);
      const write = handle.writeFile.bind(handle);
      const sync = handle.sync.bind(handle);
      if (fsControl.writeError && path.includes(fsControl.writeError)) {
        handle.writeFile = async (data: string | Uint8Array): Promise<void> => {
          await write(data.slice(0, 20));
          throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
        };
      }
      handle.sync = async () => {
        fsControl.synced.push(path);
        const code = fsControl.syncErrors[path];
        if (code) {
          throw Object.assign(new Error('flush failed'), { code });
        }
        await sync();
      };
      if (fsControl.closeError && path.includes(fsControl.closeError)) {
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          throw Object.assign(new Error('close failed'), { code: 'EIO' });
        };
      }
      return handle;
    },
  };
});

describe(InstanceIdentityRepository.name, () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'frameleaf-identity-'));
  });

  afterEach(async () => {
    fsControl.readError = null;
    fsControl.writeError = null;
    fsControl.synced = [];
    fsControl.syncErrors = {};
    fsControl.closeError = null;
    await rm(dir, { recursive: true, force: true });
  });

  /** Where `file` was set aside (FL-175): unique `<file>.corrupt-…` names. */
  const setAsideOf = async (file: string) =>
    (await readdir(dir)).filter((name) => name.startsWith(`${file}${SET_ASIDE_MARK}`)).map((name) => join(dir, name));

  it('computes the RFC 7638 thumbprint of an Ed25519 key (RFC 8037 appendix A.3 vector)', () => {
    expect(ed25519Thumbprint({ kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' })).toBe(
      'kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k',
    );
  });

  it('creates a UUIDv7 instance id and a 0600 Ed25519 key once', async () => {
    const identity = await new InstanceIdentityRepository().loadOrCreate(join(dir, 'identity'), null);

    expect(identity.instanceId).toMatch(/^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
    expect(identity.keyFile).toBe(join(dir, 'identity', INSTANCE_KEY_FILE));
    expect(identity.kid).toBe(ed25519Thumbprint(identity.publicJwk));
    expect((await stat(identity.keyFile)).mode & 0o777).toBe(0o600);

    const again = await new InstanceIdentityRepository().loadOrCreate(join(dir, 'identity'), identity);
    expect(again).toEqual(identity);
  });

  it('lets a second worker racing the first find the existing key instead of overwriting it', async () => {
    const [first, second] = await Promise.all([
      new InstanceIdentityRepository().loadOrCreate(dir, null),
      new InstanceIdentityRepository().loadOrCreate(dir, null),
    ]);
    expect(first.kid).toBe(second.kid);
    const pem = await readFile(join(dir, INSTANCE_KEY_FILE), 'utf8');
    expect(pem).toContain('BEGIN PRIVATE KEY');
    // the staging copies used to publish the key atomically are gone
    expect(await readdir(dir)).toEqual([INSTANCE_KEY_FILE]);
  });

  it('never leaves a partial key when writing the first key fails (ENOSPC), with or without hard links', async () => {
    for (const linkError of [null, 'EPERM']) {
      fsControl.linkError = linkError;
      fsControl.writeError = `${INSTANCE_KEY_FILE}.`;
      try {
        await expect(new InstanceIdentityRepository().loadOrCreate(dir, null)).rejects.toMatchObject({
          code: 'ENOSPC',
        });
      } finally {
        fsControl.linkError = null;
        fsControl.writeError = null;
      }
      expect(await readdir(dir)).toEqual([]);
    }
    await expect(new InstanceIdentityRepository().loadOrCreate(dir, null)).resolves.toHaveProperty('kid');
  });

  it('removes staging copies a crash left, which are second links to the private key', async () => {
    const identity = await new InstanceIdentityRepository().loadOrCreate(dir, null);
    const staging = `${identity.keyFile}.${randomUUID()}.tmp`;
    await link(identity.keyFile, staging);
    await writeFile(join(dir, 'unrelated.txt'), 'kept');
    await new InstanceIdentityRepository().loadOrCreate(dir, identity);
    await expect(access(staging)).rejects.toThrow();
    expect((await readdir(dir)).toSorted()).toEqual([INSTANCE_KEY_FILE, 'unrelated.txt']);
  });

  it('creates the key by rename where the file system cannot hard-link (EPERM)', async () => {
    fsControl.linkError = 'EPERM';
    try {
      const identity = await new InstanceIdentityRepository().loadOrCreate(dir, null);
      expect((await stat(identity.keyFile)).mode & 0o777).toBe(0o600);
      await expect(new InstanceIdentityRepository().loadOrCreate(dir, identity)).resolves.toMatchObject({
        kid: identity.kid,
      });
    } finally {
      fsControl.linkError = null;
    }
    expect(await readdir(dir)).toEqual([INSTANCE_KEY_FILE]);
  });

  it('refuses a key file that is not Ed25519', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    await writeFile(join(dir, INSTANCE_KEY_FILE), privateKey.export({ format: 'pem', type: 'pkcs8' }));
    await expect(new InstanceIdentityRepository().loadOrCreate(dir, null)).rejects.toThrow('not an Ed25519 key');
  });

  it('signs a private_key_jwt client assertion that verifies with the public JWK', async () => {
    const repository = new InstanceIdentityRepository();
    const identity = await repository.loadOrCreate(dir, null);
    const now = Date.UTC(2026, 8, 25, 12);
    const assertion = repository.signAssertion(identity.kid, identity.instanceId, 'https://id.cloud.test/token', {
      now,
      ttlSeconds: 3600,
    });
    const [header, payload, signature] = assertion.split('.', 3);

    expect(decode(header)).toEqual({ alg: 'EdDSA', typ: 'JWT', kid: identity.kid });
    const claims = decode(payload);
    expect(claims).toMatchObject({
      iss: identity.instanceId,
      sub: identity.instanceId,
      aud: 'https://id.cloud.test/token',
      iat: now / 1000,
    });
    expect(claims.exp - claims.iat).toBe(300);
    expect(claims.jti).toEqual(expect.any(String));
    expect(
      verify(
        null,
        Buffer.from(`${header}.${payload}`),
        createPublicKey({ key: identity.publicJwk, format: 'jwk' }),
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);
  });

  it('refuses to sign before the key is loaded', () => {
    expect(() => new InstanceIdentityRepository().signAssertion('kid', 'id', 'aud')).toThrow('not loaded');
  });
  describe('key rotation (FL-155)', () => {
    const newPem = () => generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;

    it('swaps the key only after the cloud accepted it, keeping the old one retiring', async () => {
      const repository = new InstanceIdentityRepository();
      const identity = await repository.loadOrCreate(dir, null);
      await expect(repository.rotate(identity, () => Promise.reject(new Error('refused')), 24)).rejects.toThrow(
        'refused',
      );
      await expect(repository.loadOrCreate(dir, identity)).resolves.toMatchObject({ kid: identity.kid });

      const rotated = await repository.rotate(identity, () => Promise.resolve(), 24);
      expect(rotated.kid).not.toBe(identity.kid);
      expect(rotated.retiring).toMatchObject({ kid: identity.kid, keyFile: join(dir, RETIRING_KEY_FILE) });
      await expect(access(join(dir, PROVEN_KEY_FILE))).rejects.toThrow();
    });

    it('finishes a rotation a crash interrupted after the cloud accepted the new key', async () => {
      const identity = await new InstanceIdentityRepository().loadOrCreate(dir, null);
      // crash right after the accepted key was set aside, before it replaced the current one
      await writeFile(join(dir, PROVEN_KEY_FILE), newPem(), { mode: 0o600 });

      const recovered = await new InstanceIdentityRepository().loadOrCreate(dir, identity);
      expect(recovered.kid).not.toBe(identity.kid);
      expect(recovered.instanceId).toBe(identity.instanceId);
      expect(recovered.retiring).toMatchObject({ kid: identity.kid, keyFile: join(dir, RETIRING_KEY_FILE) });
      await expect(access(join(dir, PROVEN_KEY_FILE))).rejects.toThrow();
    });

    it('keeps a new key whose registration was in flight at a crash as the candidate', async () => {
      const identity = await new InstanceIdentityRepository().loadOrCreate(dir, null);
      await writeFile(join(dir, 'instance-key.next.pem'), newPem(), { mode: 0o600 });
      const again = await new InstanceIdentityRepository().loadOrCreate(dir, identity);
      expect(again.kid).toBe(identity.kid);
      expect(again.retiring).toBeUndefined();
      expect(again.candidate).toMatchObject({ keyFile: join(dir, CANDIDATE_KEY_FILE) });
      await expect(access(join(dir, 'instance-key.next.pem'))).rejects.toThrow();
    });

    it('discards a next key a crash left half written and keeps the current key (FL-175)', async () => {
      const identity = await new InstanceIdentityRepository().loadOrCreate(dir, null);
      const partial = newPem().slice(0, 40);
      await writeFile(join(dir, 'instance-key.next.pem'), partial, { mode: 0o600 });

      const again = await new InstanceIdentityRepository().loadOrCreate(dir, identity);
      expect(again.kid).toBe(identity.kid);
      expect(again.candidate).toBeUndefined();
      await expect(access(join(dir, 'instance-key.next.pem'))).rejects.toThrow();
      // set aside for an operator, not left where the next load would trip over it again
      const [setAside, ...others] = await setAsideOf(NEXT_KEY_FILE);
      expect(others).toEqual([]);
      expect(await readFile(setAside, 'utf8')).toBe(partial);
      expect((await stat(setAside)).mode & 0o777).toBe(0o600);
      await expect(access(join(dir, CANDIDATE_KEY_FILE))).rejects.toThrow();
      await expect(access(join(dir, 'instance-key.candidate.json'))).rejects.toThrow();
      await expect(new InstanceIdentityRepository().loadOrCreate(dir, identity)).resolves.toMatchObject({
        kid: identity.kid,
      });
    });

    it('discards a candidate key that does not parse, with its sidecar (FL-175)', async () => {
      const identity = await new InstanceIdentityRepository().loadOrCreate(dir, null);
      await writeFile(join(dir, CANDIDATE_KEY_FILE), newPem().slice(0, 40), { mode: 0o600 });
      await writeFile(join(dir, 'instance-key.candidate.json'), '{}', { mode: 0o600 });

      const again = await new InstanceIdentityRepository().loadOrCreate(dir, identity);
      expect(again.kid).toBe(identity.kid);
      expect(again.candidate).toBeUndefined();
      await expect(access(join(dir, CANDIDATE_KEY_FILE))).rejects.toThrow();
      await expect(access(join(dir, 'instance-key.candidate.json'))).rejects.toThrow();
    });

    it('sets aside a garbage candidate key, keeping its bytes because the cloud may hold it (FL-175)', async () => {
      const identity = await new InstanceIdentityRepository().loadOrCreate(dir, null);
      const garbage = randomBytes(96);
      await writeFile(join(dir, CANDIDATE_KEY_FILE), garbage, { mode: 0o600 });
      await writeFile(
        join(dir, 'instance-key.candidate.json'),
        JSON.stringify({ kid: 'x', since: new Date().toISOString() }),
        { mode: 0o600 },
      );

      const again = await new InstanceIdentityRepository().loadOrCreate(dir, identity);
      expect(again.kid).toBe(identity.kid);
      expect(again.candidate).toBeUndefined();
      await expect(access(join(dir, CANDIDATE_KEY_FILE))).rejects.toThrow();
      await expect(access(join(dir, 'instance-key.candidate.json'))).rejects.toThrow();
      const [setAside] = await setAsideOf(CANDIDATE_KEY_FILE);
      expect(await readFile(setAside)).toEqual(garbage);
      // the next load is clean
      await expect(new InstanceIdentityRepository().loadOrCreate(dir, identity)).resolves.not.toHaveProperty(
        'candidate',
      );
    });

    it('carries on with the current key when a next key vanishes before it is read (FL-175)', async () => {
      const identity = await new InstanceIdentityRepository().loadOrCreate(dir, null);
      await writeFile(join(dir, 'instance-key.next.pem'), newPem(), { mode: 0o600 });
      // a candidate sidecar whose key is missing is stale
      await writeFile(join(dir, 'instance-key.candidate.json'), '{}', { mode: 0o600 });
      fsControl.readError = { file: 'instance-key.next.pem', code: 'ENOENT' };

      const again = await new InstanceIdentityRepository().loadOrCreate(dir, identity);
      expect(again.kid).toBe(identity.kid);
      expect(again.candidate).toBeUndefined();
      await expect(setAsideOf(NEXT_KEY_FILE)).resolves.toEqual([]);
      await expect(access(join(dir, 'instance-key.candidate.json'))).rejects.toThrow();
    });

    it('moves nothing when a next or candidate key cannot be read for permissions (FL-175)', async () => {
      const identity = await new InstanceIdentityRepository().loadOrCreate(dir, null);
      const pem = newPem();
      for (const file of ['instance-key.next.pem', CANDIDATE_KEY_FILE]) {
        await writeFile(join(dir, file), pem, { mode: 0o600 });
        fsControl.readError = { file, code: 'EACCES' };
        await expect(new InstanceIdentityRepository().loadOrCreate(dir, identity)).rejects.toMatchObject({
          code: 'EACCES',
        });
        fsControl.readError = null;
        expect(await readFile(join(dir, file), 'utf8')).toBe(pem);
        await expect(setAsideOf(file)).resolves.toEqual([]);
        await rm(join(dir, file));
      }
      expect(await readFile(identity.keyFile, 'utf8')).toContain('BEGIN PRIVATE KEY');
    });

    it('never replaces or moves a current key that does not parse (FL-175)', async () => {
      const identity = await new InstanceIdentityRepository().loadOrCreate(dir, null);
      const partial = (await readFile(identity.keyFile, 'utf8')).slice(0, 40);
      for (const content of [partial, '']) {
        await writeFile(identity.keyFile, content, { mode: 0o600 });
        await expect(new InstanceIdentityRepository().loadOrCreate(dir, identity)).rejects.toThrow(
          'is not a readable private key',
        );
        expect(await readFile(identity.keyFile, 'utf8')).toBe(content);
        await expect(setAsideOf(INSTANCE_KEY_FILE)).resolves.toEqual([]);
      }
    });

    it('keeps the current key when a proven key no longer parses, and asks for a new rotation (FL-175)', async () => {
      const repository = new InstanceIdentityRepository();
      const identity = await repository.loadOrCreate(dir, null);
      const damaged = newPem().slice(0, 60);
      await writeFile(join(dir, PROVEN_KEY_FILE), damaged, { mode: 0o644 });

      const start = Date.now();
      const again = await repository.loadOrCreate(dir, identity, start);
      expect(again.kid).toBe(identity.kid);
      expect(again.retiring).toBeUndefined();
      expect(again.rotationNeeded).toEqual({
        since: new Date(start).toISOString(),
        until: new Date(start + 24 * 60 * 60 * 1000).toISOString(),
      });
      await expect(access(join(dir, PROVEN_KEY_FILE))).rejects.toThrow();
      const [setAside] = await setAsideOf(PROVEN_KEY_FILE);
      expect(await readFile(setAside, 'utf8')).toBe(damaged);
      expect((await stat(setAside)).mode & 0o777).toBe(0o600);
      // still asked for on every load until a rotation finishes
      await expect(repository.loadOrCreate(dir, again, start + 1000)).resolves.toMatchObject({
        rotationNeeded: { since: new Date(start).toISOString() },
      });

      const rotated = await repository.rotate(again, () => Promise.resolve(), 24);
      expect(rotated.rotationNeeded).toBeUndefined();
      await expect(access(join(dir, ROTATION_NEEDED_FILE))).rejects.toThrow();
      await expect(repository.loadOrCreate(dir, rotated)).resolves.not.toHaveProperty('rotationNeeded');
    });

    it('keeps the marker of a crash between asking for a rotation and setting the key aside (FL-175)', async () => {
      const identity = await new InstanceIdentityRepository().loadOrCreate(dir, null);
      // the crash: the marker was written, the damaged proven key not yet moved
      const since = Date.now() - 3 * 60 * 60 * 1000;
      const marker = {
        since: new Date(since).toISOString(),
        until: new Date(since + 24 * 60 * 60 * 1000).toISOString(),
      };
      await writeFile(join(dir, ROTATION_NEEDED_FILE), JSON.stringify(marker));
      await writeFile(join(dir, PROVEN_KEY_FILE), 'damaged', { mode: 0o600 });

      const again = await new InstanceIdentityRepository().loadOrCreate(dir, identity);
      expect(again.kid).toBe(identity.kid);
      // the earlier marker stands: the original deadline is never pushed back
      expect(again.rotationNeeded).toEqual(marker);
      await expect(setAsideOf(PROVEN_KEY_FILE)).resolves.toHaveLength(1);
    });

    it('flushes the marker before setting the key aside, and moves nothing when it cannot (FL-175)', async () => {
      const identity = await new InstanceIdentityRepository().loadOrCreate(dir, null);
      await writeFile(join(dir, PROVEN_KEY_FILE), 'damaged', { mode: 0o600 });
      fsControl.syncErrors = { [join(dir, `${ROTATION_NEEDED_FILE}.tmp`)]: 'EIO' };
      await expect(new InstanceIdentityRepository().loadOrCreate(dir, identity)).rejects.toMatchObject({ code: 'EIO' });
      expect(await readFile(join(dir, PROVEN_KEY_FILE), 'utf8')).toBe('damaged');
      await expect(access(join(dir, ROTATION_NEEDED_FILE))).rejects.toThrow();

      fsControl.syncErrors = {};
      fsControl.synced = [];
      await expect(new InstanceIdentityRepository().loadOrCreate(dir, identity)).resolves.toHaveProperty(
        'rotationNeeded',
      );
      expect(fsControl.synced).toContain(join(dir, `${ROTATION_NEEDED_FILE}.tmp`));
    });

    it('still asks for a rotation when the marker cannot be understood (FL-175)', async () => {
      const identity = await new InstanceIdentityRepository().loadOrCreate(dir, null);
      await writeFile(join(dir, ROTATION_NEEDED_FILE), '{"since": ');
      const now = Date.now();
      const again = await new InstanceIdentityRepository().loadOrCreate(dir, identity, now);
      expect(again.rotationNeeded).toEqual({
        since: new Date(now).toISOString(),
        until: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
      });
      expect(JSON.parse(await readFile(join(dir, ROTATION_NEEDED_FILE), 'utf8'))).toEqual(again.rotationNeeded);
    });

    it('clears the marker on request (FL-175)', async () => {
      const repository = new InstanceIdentityRepository();
      const identity = await repository.loadOrCreate(dir, null);
      await writeFile(join(dir, ROTATION_NEEDED_FILE), '{}');
      await repository.clearRotationNeeded(dir);
      await expect(repository.loadOrCreate(dir, identity)).resolves.not.toHaveProperty('rotationNeeded');
    });

    it('reports no phantom retiring key when a promotion sets a damaged current key aside (FL-175)', async () => {
      const repository = new InstanceIdentityRepository();
      const identity = await repository.loadOrCreate(dir, null);
      // an older rotation left a retiring key and sidecar
      const rotated = await repository.rotate(identity, () => Promise.resolve(), 24);
      await writeFile(join(dir, CANDIDATE_KEY_FILE), newPem(), { mode: 0o600 });
      const pending = await repository.loadOrCreate(dir, rotated);
      expect(pending.candidate).toBeDefined();
      await writeFile(pending.keyFile, 'damaged', { mode: 0o600 });

      const promoted = await repository.promoteCandidate(pending, 24);
      expect(promoted.kid).toBe(pending.candidate!.kid);
      expect(promoted.retiring).toBeUndefined();
      await expect(access(join(dir, RETIRING_KEY_FILE))).rejects.toThrow();
      await expect(access(join(dir, RETIRING_META_FILE))).rejects.toThrow();
      await expect(setAsideOf(INSTANCE_KEY_FILE)).resolves.toHaveLength(1);
      await expect(new InstanceIdentityRepository().loadOrCreate(dir, promoted)).resolves.toMatchObject({
        kid: promoted.kid,
      });
    });

    it('finishes a rotation whose last flush fails, once the key is in place (FL-175)', async () => {
      const repository = new InstanceIdentityRepository();
      const identity = await repository.loadOrCreate(dir, null);
      const rotated = await repository.rotate(
        identity,
        () => {
          // the cloud accepted the key; only the flush after the swap fails
          fsControl.syncErrors = { [dir]: 'EIO' };
          return Promise.resolve();
        },
        24,
      );
      expect(rotated.kid).not.toBe(identity.kid);
      fsControl.syncErrors = {};
      await expect(new InstanceIdentityRepository().loadOrCreate(dir, rotated)).resolves.toMatchObject({
        kid: rotated.kid,
      });
    });

    it('removes a new key whose close fails and reports the first error (FL-175)', async () => {
      const repository = new InstanceIdentityRepository();
      const identity = await repository.loadOrCreate(dir, null);
      const prove = vi.fn(() => Promise.resolve());
      fsControl.closeError = NEXT_KEY_FILE;
      await expect(repository.rotate(identity, prove, 24)).rejects.toMatchObject({ code: 'EIO' });
      await expect(access(join(dir, NEXT_KEY_FILE))).rejects.toThrow();

      fsControl.writeError = NEXT_KEY_FILE;
      await expect(repository.rotate(identity, prove, 24)).rejects.toMatchObject({ code: 'ENOSPC' });
      await expect(access(join(dir, NEXT_KEY_FILE))).rejects.toThrow();
      expect(prove).not.toHaveBeenCalled();
    });

    it('swaps in a readable proven key over a current key that does not parse (FL-175)', async () => {
      const identity = await new InstanceIdentityRepository().loadOrCreate(dir, null);
      const proven = generateKeyPairSync('ed25519').privateKey;
      await writeFile(join(dir, PROVEN_KEY_FILE), proven.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
      await writeFile(identity.keyFile, 'damaged', { mode: 0o600 });

      const again = await new InstanceIdentityRepository().loadOrCreate(dir, identity);
      const jwk = createPublicKey(proven).export({ format: 'jwk' });
      expect(again.kid).toBe(ed25519Thumbprint({ kty: 'OKP', crv: 'Ed25519', x: jwk.x! }));
      expect(again.retiring).toBeUndefined();
      await expect(access(join(dir, PROVEN_KEY_FILE))).rejects.toThrow();
      const [setAside] = await setAsideOf(INSTANCE_KEY_FILE);
      expect(await readFile(setAside, 'utf8')).toBe('damaged');
    });

    it('gives every set-aside file its own name', async () => {
      const identity = await new InstanceIdentityRepository().loadOrCreate(dir, null);
      for (const partial of ['-----BEGIN', '-----BEGIN PRIVATE']) {
        await writeFile(join(dir, NEXT_KEY_FILE), partial, { mode: 0o600 });
        await new InstanceIdentityRepository().loadOrCreate(dir, identity);
      }
      const setAside = await setAsideOf(NEXT_KEY_FILE);
      expect(setAside).toHaveLength(2);
      expect((await Promise.all(setAside.map((file) => readFile(file, 'utf8')))).toSorted()).toEqual([
        '-----BEGIN',
        '-----BEGIN PRIVATE',
      ]);
    });

    it('sets aside a retiring key that no longer parses instead of failing the load (FL-175)', async () => {
      const repository = new InstanceIdentityRepository();
      const identity = await repository.loadOrCreate(dir, null);
      const rotated = await repository.rotate(identity, () => Promise.resolve(), 24);
      // a copy on a mount without hard links, cut short by a power failure
      await rm(join(dir, RETIRING_KEY_FILE));
      await writeFile(join(dir, RETIRING_KEY_FILE), 'garbage', { mode: 0o600 });

      const again = await new InstanceIdentityRepository().loadOrCreate(dir, rotated);
      expect(again.kid).toBe(rotated.kid);
      expect(again.retiring).toBeUndefined();
      await expect(access(join(dir, 'instance-key.retiring.json'))).rejects.toThrow();
      await expect(setAsideOf(RETIRING_KEY_FILE)).resolves.toHaveLength(1);
    });

    it('leaves out a retiring key that cannot be read, without failing the load (FL-175)', async () => {
      const repository = new InstanceIdentityRepository();
      const identity = await repository.loadOrCreate(dir, null);
      const rotated = await repository.rotate(identity, () => Promise.resolve(), 24);
      fsControl.readError = { file: RETIRING_KEY_FILE, code: 'EACCES' };

      const again = await new InstanceIdentityRepository().loadOrCreate(dir, rotated);
      expect(again.kid).toBe(rotated.kid);
      expect(again.retiring).toBeUndefined();
      fsControl.readError = null;
      await expect(access(join(dir, RETIRING_KEY_FILE))).resolves.toBeUndefined();
      await expect(access(join(dir, RETIRING_META_FILE))).resolves.toBeUndefined();
      await expect(setAsideOf(RETIRING_KEY_FILE)).resolves.toEqual([]);
    });

    it('removes a retired key only while its sidecar names the same rotation (FL-175)', async () => {
      const repository = new InstanceIdentityRepository();
      const identity = await repository.loadOrCreate(dir, null);
      const rotated = await repository.rotate(identity, () => Promise.resolve(), 24);
      const stale = { ...rotated, retiring: { ...rotated.retiring!, rotationId: randomUUID() } };
      await expect(repository.removeRetired(dir, stale)).resolves.toEqual(stale);
      await expect(access(join(dir, RETIRING_KEY_FILE))).resolves.toBeUndefined();

      await expect(repository.removeRetired(dir, rotated)).resolves.not.toHaveProperty('retiring');
      await expect(access(join(dir, RETIRING_KEY_FILE))).rejects.toThrow();
      await expect(access(join(dir, RETIRING_META_FILE))).rejects.toThrow();
    });

    it('has the whole new key flushed to disk before the cloud is asked to register it (FL-175)', async () => {
      const repository = new InstanceIdentityRepository();
      const identity = await repository.loadOrCreate(dir, null);
      const nextFile = join(dir, NEXT_KEY_FILE);
      const seen: string[] = [];
      let flushed: string[] = [];
      await repository.rotate(
        identity,
        async (newJwk) => {
          flushed = [...fsControl.synced];
          const pem = await readFile(nextFile);
          const jwk = createPublicKey(pem).export({ format: 'jwk' });
          seen.push(ed25519Thumbprint({ kty: 'OKP', crv: 'Ed25519', x: jwk.x! }), newJwk.kid);
        },
        24,
      );
      expect(seen).toHaveLength(2);
      expect(seen[0]).toBe(seen[1]);
      // the key file itself, then the directory holding its name
      expect(flushed.indexOf(nextFile)).toBeGreaterThanOrEqual(0);
      expect(flushed.lastIndexOf(dir)).toBeGreaterThan(flushed.indexOf(nextFile));
    });

    it('stops a rotation before the cloud hears of it when the flush fails (EIO) (FL-175)', async () => {
      const repository = new InstanceIdentityRepository();
      const identity = await repository.loadOrCreate(dir, null);
      const prove = vi.fn(() => Promise.resolve());
      fsControl.syncErrors = { [dir]: 'EIO' };
      await expect(repository.rotate(identity, prove, 24)).rejects.toMatchObject({ code: 'EIO' });
      fsControl.syncErrors = { [join(dir, NEXT_KEY_FILE)]: 'EIO' };
      await expect(repository.rotate(identity, prove, 24)).rejects.toMatchObject({ code: 'EIO' });
      expect(prove).not.toHaveBeenCalled();
      await expect(access(join(dir, NEXT_KEY_FILE))).rejects.toThrow();
    });

    it('rotates on a mount that cannot flush, logging that once (FL-175)', async () => {
      const repository = new InstanceIdentityRepository();
      const warn = vi.spyOn((repository as unknown as { logger: { warn: (message: string) => void } }).logger, 'warn');
      const identity = await repository.loadOrCreate(dir, null);
      fsControl.syncErrors = { [dir]: 'EINVAL', [join(dir, NEXT_KEY_FILE)]: 'ENOTSUP' };
      const first = await repository.rotate(identity, () => Promise.resolve(), 24);
      await repository.rotate(first, () => Promise.resolve(), 24);
      expect(warn.mock.calls.filter(([message]) => String(message).includes('cannot flush'))).toHaveLength(1);
    });

    it('removes a next key whose write fails, before the cloud hears of it (ENOSPC) (FL-175)', async () => {
      const repository = new InstanceIdentityRepository();
      const identity = await repository.loadOrCreate(dir, null);
      const prove = vi.fn(() => Promise.resolve());
      fsControl.writeError = NEXT_KEY_FILE;
      await expect(repository.rotate(identity, prove, 24)).rejects.toMatchObject({ code: 'ENOSPC' });
      expect(prove).not.toHaveBeenCalled();
      await expect(access(join(dir, NEXT_KEY_FILE))).rejects.toThrow();
    });

    it('does not replace a next key of a rotation already under way (FL-175)', async () => {
      const repository = new InstanceIdentityRepository();
      const identity = await repository.loadOrCreate(dir, null);
      const pem = newPem();
      await writeFile(join(dir, NEXT_KEY_FILE), pem, { mode: 0o600 });
      await expect(repository.rotate(identity, () => Promise.resolve(), 24)).rejects.toThrow('already under way');
      expect(await readFile(join(dir, NEXT_KEY_FILE), 'utf8')).toBe(pem);
    });

    it('falls back to a 0600 copy when the file system cannot hard-link (EPERM)', async () => {
      const repository = new InstanceIdentityRepository();
      const identity = await repository.loadOrCreate(dir, null);
      const before = await readFile(join(dir, INSTANCE_KEY_FILE), 'utf8');
      fsControl.linkError = 'EPERM';
      try {
        const rotated = await repository.rotate(identity, () => Promise.resolve(), 24);
        expect(rotated.kid).not.toBe(identity.kid);
      } finally {
        fsControl.linkError = null;
      }
      expect(await readFile(join(dir, RETIRING_KEY_FILE), 'utf8')).toBe(before);
      expect((await stat(join(dir, RETIRING_KEY_FILE))).mode & 0o777).toBe(0o600);
    });

    it('still rotates when the mount refuses both link and chmod (EPERM)', async () => {
      const repository = new InstanceIdentityRepository();
      const identity = await repository.loadOrCreate(dir, null);
      fsControl.linkError = 'EPERM';
      fsControl.chmodError = 'EPERM';
      try {
        const rotated = await repository.rotate(identity, () => Promise.resolve(), 24);
        expect(rotated.kid).not.toBe(identity.kid);
      } finally {
        fsControl.linkError = null;
        fsControl.chmodError = null;
      }
      await expect(access(join(dir, RETIRING_KEY_FILE))).resolves.toBeUndefined();
    });

    it('keeps the new key as the candidate when the answer to its registration is lost', async () => {
      const repository = new InstanceIdentityRepository();
      const identity = await repository.loadOrCreate(dir, null);
      const lost = Object.assign(new Error('timeout'), { lost: true });
      await expect(
        repository.rotate(
          identity,
          () => Promise.reject(lost),
          24,
          Date.now(),
          (error) => !(error as typeof lost).lost,
        ),
      ).rejects.toThrow('timeout');

      const pending = await repository.loadOrCreate(dir, identity);
      expect(pending.kid).toBe(identity.kid);
      expect(pending.candidate?.kid).toEqual(expect.any(String));

      // the cloud turns out to hold it: the rotation is finished
      const promoted = await repository.promoteCandidate(pending, 24);
      expect(promoted.kid).toBe(pending.candidate!.kid);
      expect(promoted.candidate).toBeUndefined();
      expect(promoted.retiring).toMatchObject({ kid: identity.kid });
      await expect(repository.loadOrCreate(dir, promoted)).resolves.toMatchObject({ kid: promoted.kid });
    });

    it('forgets a candidate after the one-day window, and when the cloud refuses it', async () => {
      const repository = new InstanceIdentityRepository();
      const identity = await repository.loadOrCreate(dir, null);
      await writeFile(join(dir, CANDIDATE_KEY_FILE), newPem(), { mode: 0o600 });
      const withCandidate = await repository.loadOrCreate(dir, identity);
      await expect(repository.discardCandidate(withCandidate)).resolves.not.toHaveProperty('candidate');
      await expect(access(join(dir, CANDIDATE_KEY_FILE))).rejects.toThrow();

      await writeFile(join(dir, CANDIDATE_KEY_FILE), newPem(), { mode: 0o600 });
      const start = Date.now();
      await expect(repository.loadOrCreate(dir, identity, start)).resolves.toHaveProperty('candidate');
      const later = await repository.loadOrCreate(dir, identity, start + 25 * 60 * 60 * 1000);
      expect(later.candidate).toBeUndefined();
      await expect(access(join(dir, CANDIDATE_KEY_FILE))).rejects.toThrow();
    });

    it('times the candidate by this server’s clock, not the file’s modification time', async () => {
      const repository = new InstanceIdentityRepository();
      const identity = await repository.loadOrCreate(dir, null);
      await writeFile(join(dir, CANDIDATE_KEY_FILE), newPem(), { mode: 0o600 });
      const start = Date.now();
      const first = await repository.loadOrCreate(dir, identity, start);
      expect(first.candidate?.since).toBe(new Date(start).toISOString());
      // a NAS with a clock far ahead keeps touching the file into the future
      const future = new Date(start + 10 * 24 * 60 * 60 * 1000);
      await utimes(join(dir, CANDIDATE_KEY_FILE), future, future);
      const later = await repository.loadOrCreate(dir, identity, start + 25 * 60 * 60 * 1000);
      expect(later.candidate).toBeUndefined();
      await expect(access(join(dir, CANDIDATE_KEY_FILE))).rejects.toThrow();
    });

    it('rebuilds retiring metadata for the latest rotation, never an older one', async () => {
      const repository = new InstanceIdentityRepository();
      const identity = await repository.loadOrCreate(dir, null);
      const first = await repository.rotate(identity, () => Promise.resolve(), 24);
      // a second rotation whose metadata save never happened (crash after the swap)
      const second = await repository.rotate(first, () => Promise.resolve(), 48);

      const loaded = await new InstanceIdentityRepository().loadOrCreate(dir, first);
      expect(loaded.kid).toBe(second.kid);
      expect(loaded.retiring).toEqual(second.retiring);
      expect(loaded.retiring?.rotationId).not.toBe(first.retiring?.rotationId);
      expect(loaded.retiring?.kid).toBe(first.kid);
    });
  });
});
