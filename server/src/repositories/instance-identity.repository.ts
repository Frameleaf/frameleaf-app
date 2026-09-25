import { Injectable } from '@nestjs/common';
import { type KeyObject, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, copyFile, link, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import type { FrameleafInstanceIdentity } from 'src/types.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { base64url, ed25519Thumbprint } from 'src/utils/frameleaf-cloud.js';

/** File name of the private key inside the identity directory. */
export const INSTANCE_KEY_FILE = 'instance-key.pem';
/** A key being introduced by rotation, before the cloud accepted it. */
const NEXT_KEY_FILE = 'instance-key.next.pem';
/** The key a rotation replaced, kept until the cloud stops accepting it. */
export const RETIRING_KEY_FILE = 'instance-key.retiring.pem';
/** A new key the cloud accepted, about to replace the current one (see `finishRotation`). */
export const PROVEN_KEY_FILE = 'instance-key.proven.pem';
/** How long a retiring key found while recovering an interrupted rotation is kept. */
const RECOVERED_RETIRE_HOURS = 24;
/** A new key whose registration answer was lost; see `FrameleafInstanceIdentity.candidate`. */
export const CANDIDATE_KEY_FILE = 'instance-key.candidate.pem';
/** When the candidate key became one, by this server's clock (not the file system's): `{kid, since}`. */
const CANDIDATE_META_FILE = 'instance-key.candidate.json';
/** How long a candidate key is kept (the cloud's retire window). */
export const CANDIDATE_HOURS = 24;
/** The rotation that retired the current retiring key: `{rotationId, kid, until}`. */
const RETIRING_META_FILE = 'instance-key.retiring.json';
/** `link()` failures where the file system cannot hard-link (SMB/CIFS, FUSE, another device). */
const NO_HARD_LINK = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV']);

const exists = (path: string) =>
  access(path)
    .then(() => true)
    .catch(() => false);

const ignore = (codes: string[]) => (error: NodeJS.ErrnoException) => {
  if (!codes.includes(error.code ?? '')) {
    throw error;
  }
};

type Ed25519PublicJwk = FrameleafInstanceIdentity['publicJwk'];

const publicJwkOf = (privateKey: KeyObject): Ed25519PublicJwk => {
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    throw new Error('The Frameleaf identity key is not an Ed25519 key');
  }
  return { kty: 'OKP', crv: 'Ed25519', x: jwk.x };
};

/**
 * This server's Frameleaf identity (FL-159 builds the part of FL-154/FL-155 cloud processing needs):
 * one Ed25519 key in a PEM file created with O_EXCL and mode 0600, its RFC 7638 `kid`, and compact
 * EdDSA JWS signing for `private_key_jwt` client assertions. The private key never leaves this
 * repository; callers get the public JWK and signatures only.
 */
@Injectable()
export class InstanceIdentityRepository {
  private cached?: { keyFile: string; privateKey: KeyObject };
  private logger = LoggingRepository.create('InstanceIdentityRepository');

  /**
   * Load the key in `dir`, or create it when there is none. Creation is exclusive (O_EXCL), so two
   * workers racing here end with one key: the loser reads the winner's file.
   */
  async loadOrCreate(
    dir: string,
    existing: Pick<FrameleafInstanceIdentity, 'instanceId' | 'createdAt' | 'retiring'> | null,
    now = Date.now(),
  ): Promise<FrameleafInstanceIdentity> {
    const keyFile = join(dir, INSTANCE_KEY_FILE);
    await this.recoverRotation(dir, now);
    let privateKey: KeyObject;
    let created = false;
    try {
      privateKey = createPrivateKey(await readFile(keyFile));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const pair = generateKeyPairSync('ed25519');
      const pem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' });
      try {
        const handle = await open(keyFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try {
          await handle.writeFile(pem);
        } finally {
          await handle.close();
        }
        privateKey = pair.privateKey;
        created = true;
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw writeError;
        }
        privateKey = createPrivateKey(await readFile(keyFile));
      }
    }
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('The Frameleaf identity key is not an Ed25519 key');
    }
    this.cached = { keyFile, privateKey };
    const publicJwk = publicJwkOf(privateKey);
    const retiring = created ? undefined : await this.retiringOf(dir, now);
    const candidate = created ? undefined : await this.candidateOf(dir, now);
    return {
      instanceId: !created && existing ? existing.instanceId : uuidv7(),
      kid: ed25519Thumbprint(publicJwk),
      publicJwk,
      keyFile,
      createdAt: !created && existing ? existing.createdAt : new Date().toISOString(),
      ...(retiring && { retiring }),
      ...(candidate && { candidate }),
    };
  }

  /**
   * Finish a rotation a crash interrupted (FL-155). A key the cloud accepted is renamed to
   * `instance-key.proven.pem` before anything else changes, so on the next load a proven key always
   * replaces the current one (keeping the current one as retiring). A new key whose registration was
   * still in flight (`instance-key.next.pem`) may have reached the cloud, so it is kept as the
   * candidate rather than deleted. The key file itself is only ever replaced by an atomic rename.
   */
  private async recoverRotation(dir: string, now: number) {
    if (await exists(join(dir, PROVEN_KEY_FILE))) {
      await this.finishRotation(dir, { rotationId: randomUUID(), until: this.hoursFrom(now, RECOVERED_RETIRE_HOURS) });
    }
    if (await exists(join(dir, NEXT_KEY_FILE))) {
      await this.makeCandidate(dir, now);
    }
  }

  /**
   * Keep the current key as retiring, then atomically put the proven key in place. The retiring
   * key's rotation id, kid and expiry are written first (a sidecar, replaced atomically), so metadata
   * can always be rebuilt for exactly this rotation. The retiring copy is a hard link, or a 0600 copy
   * where the file system cannot link (SMB/CIFS, FUSE, another device).
   */
  private async finishRotation(dir: string, rotation: { rotationId: string; until: string }) {
    const keyFile = join(dir, INSTANCE_KEY_FILE);
    const retiringFile = join(dir, RETIRING_KEY_FILE);
    const current = createPrivateKey(await readFile(keyFile));
    const sidecar = join(dir, RETIRING_META_FILE);
    await writeFile(`${sidecar}.tmp`, JSON.stringify({ ...rotation, kid: ed25519Thumbprint(publicJwkOf(current)) }), {
      mode: 0o600,
    });
    await rename(`${sidecar}.tmp`, sidecar);
    await rm(retiringFile, { force: true });
    await link(keyFile, retiringFile).catch(async (error: NodeJS.ErrnoException) => {
      if (NO_HARD_LINK.has(error.code ?? '')) {
        await copyFile(keyFile, retiringFile);
        await this.restrict(retiringFile);
        return;
      }
      ignore(['EEXIST', 'ENOENT'])(error);
    });
    await rename(join(dir, PROVEN_KEY_FILE), keyFile).catch(ignore(['ENOENT']));
  }

  /** Make a key file owner-only; a mount that refuses chmod (SMB/CIFS, FUSE) only gets a warning. */
  private async restrict(file: string) {
    await chmod(file, 0o600).catch((error: NodeJS.ErrnoException) => {
      if (!NO_HARD_LINK.has(error.code ?? '')) {
        throw error;
      }
      this.logger.warn(
        `Could not make ${file} readable by this server only (${error.code}); check the mount's permissions`,
      );
    });
  }

  /**
   * The retiring key's metadata, always rebuilt from disk: its kid from the key file, its rotation
   * id and expiry from the sidecar when that describes this very key. Stale metadata of an older
   * rotation can therefore never survive a crash between the swap and the metadata save.
   */
  private async retiringOf(dir: string, now: number) {
    const retiringFile = join(dir, RETIRING_KEY_FILE);
    if (!(await exists(retiringFile))) {
      return;
    }
    const kid = ed25519Thumbprint(publicJwkOf(createPrivateKey(await readFile(retiringFile))));
    const sidecarFile = join(dir, RETIRING_META_FILE);
    type Sidecar = { rotationId?: unknown; kid?: unknown; until?: unknown };
    const sidecar = await readFile(sidecarFile, 'utf8')
      .then((text) => JSON.parse(text) as Sidecar)
      .catch((): Sidecar | null => null);
    if (sidecar?.kid === kid && typeof sidecar.rotationId === 'string' && typeof sidecar.until === 'string') {
      return { kid, keyFile: retiringFile, until: sidecar.until, rotationId: sidecar.rotationId };
    }
    const rebuilt = { rotationId: randomUUID(), kid, until: this.hoursFrom(now, RECOVERED_RETIRE_HOURS) };
    await writeFile(`${sidecarFile}.tmp`, JSON.stringify(rebuilt), { mode: 0o600 });
    await rename(`${sidecarFile}.tmp`, sidecarFile);
    return { kid, keyFile: retiringFile, until: rebuilt.until, rotationId: rebuilt.rotationId };
  }

  /** The candidate key, while its question is open (at most `CANDIDATE_HOURS`); older ones go. */
  /** The in-flight key becomes the candidate; its start time goes in a 0600 sidecar first. */
  private async makeCandidate(dir: string, now: number) {
    const nextFile = join(dir, NEXT_KEY_FILE);
    const kid = await this.kidOrDiscard(nextFile);
    if (!kid) {
      return;
    }
    await this.writeSidecar(join(dir, CANDIDATE_META_FILE), { kid, since: new Date(now).toISOString() });
    await rename(nextFile, join(dir, CANDIDATE_KEY_FILE));
  }

  /**
   * The candidate key, while its question is open: at most `CANDIDATE_HOURS` after the time in its
   * sidecar (this server's clock, so a file system with a skewed clock cannot keep it alive). A
   * candidate without a matching sidecar starts its window now.
   */
  private async candidateOf(dir: string, now: number) {
    const keyFile = join(dir, CANDIDATE_KEY_FILE);
    const metaFile = join(dir, CANDIDATE_META_FILE);
    if (!(await exists(keyFile))) {
      await rm(metaFile, { force: true });
      return;
    }
    const kid = await this.kidOrDiscard(keyFile, metaFile);
    if (!kid) {
      return;
    }
    const meta = await readFile(metaFile, 'utf8')
      .then((text) => JSON.parse(text) as { kid?: unknown; since?: unknown })
      .catch(() => null);
    let since = meta?.kid === kid && typeof meta.since === 'string' ? Date.parse(meta.since) : NaN;
    if (Number.isNaN(since)) {
      since = now;
      await this.writeSidecar(metaFile, { kid, since: new Date(since).toISOString() });
    }
    if (now - since > CANDIDATE_HOURS * 60 * 60 * 1000 || since - now > CANDIDATE_HOURS * 60 * 60 * 1000) {
      await rm(keyFile, { force: true });
      await rm(metaFile, { force: true });
      return;
    }
    return { kid, keyFile, since: new Date(since).toISOString() };
  }

  /**
   * The kid of a next or candidate key, or `undefined` after deleting a file that does not parse
   * (FL-175). Such a file is a write a crash cut short; a key whose write did not complete was never
   * sent to the cloud, so dropping it (and its sidecar) is safe and keeps the current key working.
   */
  private async kidOrDiscard(keyFile: string, sidecar?: string) {
    const pem = await readFile(keyFile);
    try {
      return ed25519Thumbprint(publicJwkOf(createPrivateKey(pem)));
    } catch (error) {
      this.logger.warn(`Discarding ${keyFile}, a Frameleaf identity key that does not parse: ${error}`);
      await rm(keyFile, { force: true });
      if (sidecar) {
        await rm(sidecar, { force: true });
      }
    }
  }

  private async writeSidecar(file: string, content: Record<string, unknown>) {
    await writeFile(`${file}.tmp`, JSON.stringify(content), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }

  private hoursFrom(now: number, hours: number) {
    return new Date(now + hours * 60 * 60 * 1000).toISOString();
  }

  /**
   * A `private_key_jwt` client assertion (RFC 7523, FL-154): EdDSA, header `kid`, with
   * `iss = sub = client_id`, the token endpoint as `aud`, a fresh `jti` and at most five minutes of
   * life. `clientId` is the instance id the cloud knows this server by.
   */
  signAssertion(
    kid: string,
    clientId: string,
    audience: string,
    { now = Date.now(), ttlSeconds = 120 }: { now?: number; ttlSeconds?: number } = {},
  ): string {
    const issuedAt = Math.floor(now / 1000);
    return this.signJws(kid, {
      iss: clientId,
      sub: clientId,
      aud: audience,
      jti: randomUUID(),
      iat: issuedAt,
      exp: issuedAt + Math.min(Math.max(ttlSeconds, 1), 300),
    });
  }

  /**
   * Rotate the identity key (FL-155, instance contract "Tokens"). A new key is written next to the
   * current one (O_EXCL, 0600); `prove` receives its public JWK and a signer that still uses the
   * current key, and must register the new key with the cloud. Only when it succeeds does the new
   * key replace the current one; the old key is kept as `instance-key.retiring.pem` until `until`.
   * When `prove` fails, the new key is removed and nothing changes.
   */
  async rotate(
    identity: FrameleafInstanceIdentity,
    prove: (
      newJwk: Ed25519PublicJwk & { kid: string },
      signWithCurrent: (payload: Record<string, unknown>) => string,
    ) => Promise<void>,
    retireHours: number,
    now = Date.now(),
    /**
     * Whether a failure of `prove` is a definite refusal. Otherwise (a timeout or a lost answer) the
     * cloud may already hold the new key, so it is kept as the candidate instead of deleted.
     */
    isRefusal: (error: unknown) => boolean = () => true,
  ): Promise<FrameleafInstanceIdentity> {
    if (!this.cached || this.cached.keyFile !== identity.keyFile) {
      throw new Error('The Frameleaf identity key is not loaded');
    }
    const dir = dirname(identity.keyFile);
    const nextFile = join(dir, NEXT_KEY_FILE);
    await rm(nextFile, { force: true });
    const pair = generateKeyPairSync('ed25519');
    const handle = await open(nextFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      await handle.writeFile(pair.privateKey.export({ format: 'pem', type: 'pkcs8' }));
    } finally {
      await handle.close();
    }
    const publicJwk = publicJwkOf(pair.privateKey);
    const kid = ed25519Thumbprint(publicJwk);
    try {
      await prove({ ...publicJwk, kid }, (payload) => this.signJws(identity.kid, payload));
    } catch (error) {
      await (isRefusal(error) ? rm(nextFile, { force: true }) : this.makeCandidate(dir, now));
      throw error;
    }
    // accepted by the cloud: from here a crash finishes the rotation on the next load
    await rename(nextFile, join(dir, PROVEN_KEY_FILE));
    return this.swapIn(identity, pair.privateKey, retireHours, now);
  }

  /**
   * The cloud accepted the candidate key after all (FL-155): make it the current key, exactly as a
   * rotation that got its answer would have.
   */
  async promoteCandidate(identity: FrameleafInstanceIdentity, retireHours: number, now = Date.now()) {
    if (!identity.candidate) {
      throw new Error('There is no candidate key');
    }
    const dir = dirname(identity.keyFile);
    const privateKey = createPrivateKey(await readFile(identity.candidate.keyFile));
    await rename(identity.candidate.keyFile, join(dir, PROVEN_KEY_FILE));
    await rm(join(dir, CANDIDATE_META_FILE), { force: true });
    return this.swapIn(identity, privateKey, retireHours, now);
  }

  /** The cloud does not hold the candidate key: forget it. */
  async discardCandidate(identity: FrameleafInstanceIdentity): Promise<FrameleafInstanceIdentity> {
    if (identity.candidate) {
      await rm(identity.candidate.keyFile, { force: true });
      await rm(join(dirname(identity.candidate.keyFile), CANDIDATE_META_FILE), { force: true });
    }
    const { candidate: _candidate, ...rest } = identity;
    return rest;
  }

  /** A signer that uses the candidate key, to ask the cloud whether it holds it. */
  async candidateSigner(identity: FrameleafInstanceIdentity) {
    const candidate = identity.candidate;
    if (!candidate) {
      throw new Error('There is no candidate key');
    }
    const privateKey = createPrivateKey(await readFile(candidate.keyFile));
    return (payload: Record<string, unknown>) => this.signWith(privateKey, candidate.kid, payload);
  }

  private async swapIn(
    identity: FrameleafInstanceIdentity,
    privateKey: KeyObject,
    retireHours: number,
    now: number,
  ): Promise<FrameleafInstanceIdentity> {
    const dir = dirname(identity.keyFile);
    const rotation = { rotationId: randomUUID(), until: this.hoursFrom(now, retireHours) };
    await this.finishRotation(dir, rotation);
    this.cached = { keyFile: identity.keyFile, privateKey };
    const publicJwk = publicJwkOf(privateKey);
    const { candidate: _candidate, ...rest } = identity;
    return {
      ...rest,
      kid: ed25519Thumbprint(publicJwk),
      publicJwk,
      retiring: { kid: identity.kid, keyFile: join(dir, RETIRING_KEY_FILE), ...rotation },
    };
  }

  /** Delete the key a rotation retired, once the cloud no longer accepts it. */
  async removeRetired(identity: FrameleafInstanceIdentity): Promise<FrameleafInstanceIdentity> {
    if (identity.retiring) {
      await rm(identity.retiring.keyFile, { force: true });
    }
    const { retiring: _retiring, ...rest } = identity;
    return rest;
  }

  /** A compact EdDSA JWS over `payload`, signed with the identity key loaded by `loadOrCreate`. */
  signJws(kid: string, payload: Record<string, unknown>, type = 'JWT'): string {
    if (!this.cached) {
      throw new Error('The Frameleaf identity key is not loaded');
    }
    return this.signWith(this.cached.privateKey, kid, payload, type);
  }

  private signWith(privateKey: KeyObject, kid: string, payload: Record<string, unknown>, type = 'JWT') {
    const header = base64url(JSON.stringify({ alg: 'EdDSA', typ: type, kid }));
    const body = base64url(JSON.stringify(payload));
    const signature = sign(null, Buffer.from(`${header}.${body}`), privateKey);
    return `${header}.${body}.${base64url(signature)}`;
  }
}
