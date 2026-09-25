import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CANDIDATE_KEY_FILE,
  INSTANCE_KEY_FILE,
  InstanceIdentityRepository,
  PROVEN_KEY_FILE,
  RETIRING_KEY_FILE,
} from 'src/repositories/instance-identity.repository.js';
import { ed25519Thumbprint } from 'src/utils/frameleaf-cloud.js';

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

/** A `link()` that can fail like it does on SMB/CIFS or FUSE media mounts. */
const fsControl = vi.hoisted(() => ({ linkError: null as string | null, chmodError: null as string | null }));
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
  };
});

describe(InstanceIdentityRepository.name, () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'frameleaf-identity-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

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
      const later = await repository.loadOrCreate(dir, identity, Date.now() + 25 * 60 * 60 * 1000);
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
