import { Injectable } from '@nestjs/common';
import { type KeyObject, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { constants } from 'node:fs';
import {
  type FileHandle,
  access,
  chmod,
  copyFile,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import type { FrameleafInstanceIdentity } from 'src/types.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { base64url, ed25519Thumbprint } from 'src/utils/frameleaf-cloud.js';
import { type FrameleafKeySigner, jwsSigningInput } from 'src/utils/frameleaf-dpop.js';

/** File name of the private key inside the identity directory. */
export const INSTANCE_KEY_FILE = 'instance-key.pem';
/** A key being introduced by rotation, before the cloud accepted it. */
export const NEXT_KEY_FILE = 'instance-key.next.pem';
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
export const RETIRING_META_FILE = 'instance-key.retiring.json';
/**
 * Written when the key the cloud accepted in a rotation could not be read (FL-175): `{since, until}`.
 * The next check-in rotates again while the cloud still accepts the current key, which it does only
 * until the original rotation's retire deadline (never extended; at most `until`). A finished
 * rotation removes it. See `FrameleafInstanceIdentity.rotationNeeded`.
 */
export const ROTATION_NEEDED_FILE = 'instance-key.rotate-needed.json';
/** A key file that does not parse is renamed to `<file>.corrupt-<time>-<random>` (FL-175). */
export const SET_ASIDE_MARK = '.corrupt-';
/**
 * A candidate key an in-flight next key replaces is renamed to `<file>.superseded-<time>-<random>`
 * (FL-178 review of FL-175): the cloud may hold it, so it is kept for an operator, never overwritten.
 */
export const SUPERSEDED_MARK = '.superseded-';
/** Staging copies `publishNewKey` leaves after a crash; each is a second hard link to the live key. */
const STAGING_FILE = /^instance-key\.pem\.[\da-f-]{36}\.tmp$/;
/** `link()` failures where the file system cannot hard-link (SMB/CIFS, FUSE, another device). */
const NO_HARD_LINK = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV']);
/** File flush failures that only mean the mount cannot flush (some FUSE file systems). */
const FILE_SYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP']);
/** Directory open or flush failures that only mean the platform or mount cannot flush a directory. */
const DIRECTORY_SYNC_UNSUPPORTED = new Set([...FILE_SYNC_UNSUPPORTED, 'EISDIR', 'EPERM', 'EACCES', 'EBADF']);

const exists = (path: string) =>
  access(path)
    .then(() => true)
    .catch(() => false);

const ignore = (codes: string[]) => (error: NodeJS.ErrnoException) => {
  if (!codes.includes(error.code ?? '')) {
    throw error;
  }
};

const isDateString = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));

const readJson = <T>(file: string): Promise<T | null> =>
  readFile(file, 'utf8')
    .then((text) => JSON.parse(text) as T)
    .catch(() => null);

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
 * one Ed25519 key in a 0600 PEM file, its RFC 7638 `kid`, and compact EdDSA JWS signing for
 * `private_key_jwt` client assertions. The private key never leaves this repository; callers get the
 * public JWK and signatures only.
 *
 * Every method that touches the files runs under `DatabaseLock.FrameleafIdentity` (the gateway's
 * `loadInstanceIdentity` and the cloud service), so loads, rotations and recoveries never interleave.
 */
@Injectable()
export class InstanceIdentityRepository {
  private cached?: { keyFile: string; privateKey: KeyObject };
  private logger = LoggingRepository.create('InstanceIdentityRepository');
  private flushSkipped = false;

  /**
   * Load the key in `dir`, or create it when there is none. Creation is exclusive (`publishNewKey`),
   * so two workers racing here end with one key: the loser reads the winner's complete file.
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
    const current = await readFile(keyFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      return null;
    });
    if (current) {
      privateKey = this.currentKeyOf(keyFile, current);
      await this.removeStaging(dir);
    } else {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const pair = generateKeyPairSync('ed25519');
      if (await this.publishNewKey(keyFile, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }))) {
        privateKey = pair.privateKey;
        created = true;
      } else {
        privateKey = this.currentKeyOf(keyFile, await readFile(keyFile));
      }
    }
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('The Frameleaf identity key is not an Ed25519 key');
    }
    this.cached = { keyFile, privateKey };
    const publicJwk = publicJwkOf(privateKey);
    const retiring = created ? undefined : await this.retiringOf(dir, now);
    const candidate = created ? undefined : await this.candidateOf(dir, now);
    const rotationNeeded = created ? undefined : await this.rotationNeededOf(dir, now);
    return {
      instanceId: !created && existing ? existing.instanceId : uuidv7(),
      kid: ed25519Thumbprint(publicJwk),
      publicJwk,
      keyFile,
      createdAt: !created && existing ? existing.createdAt : new Date().toISOString(),
      ...(retiring && { retiring }),
      ...(candidate && { candidate }),
      ...(rotationNeeded && { rotationNeeded }),
    };
  }

  /**
   * The current key, parsed. A current key that does not parse is never replaced or moved here
   * (FL-175): the cloud may know it, and only an operator can tell a cut-short first write from damage
   * to a key that was in use, so loading stops with an error that says what to do. (The one exception
   * is `finishRotation`, when the cloud already accepted a readable successor.)
   */
  private currentKeyOf(keyFile: string, pem: Buffer) {
    try {
      return createPrivateKey(pem);
    } catch (error) {
      throw new Error(
        `The Frameleaf identity key ${keyFile} is not a readable private key (${error}). It was left as it is: restore it from a backup, or remove it to give this server a new identity and link it again.`,
      );
    }
  }

  /**
   * Put a new current key in place without ever exposing a partly written file: it is written and
   * flushed under a unique name, then hard-linked to `keyFile`, which fails with EEXIST when another
   * worker got there first. Where the file system cannot hard-link, the staged file is renamed into
   * place after checking that no key appeared meanwhile; a rename would replace one, which only the
   * identity lock every caller holds rules out. Returns whether this call created the key.
   */
  private async publishNewKey(keyFile: string, pem: string | Buffer) {
    const staging = `${keyFile}.${randomUUID()}.tmp`;
    try {
      await this.writeKeyExclusive(staging, pem);
      try {
        await link(staging, keyFile);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? '';
        // ENOENT: a loader that found the winner's key already removed this staging copy
        if (code === 'EEXIST' || (code === 'ENOENT' && (await exists(keyFile)))) {
          return false;
        }
        if (!NO_HARD_LINK.has(code)) {
          throw error;
        }
        if (await exists(keyFile)) {
          return false;
        }
        await rename(staging, keyFile);
      }
    } finally {
      await rm(staging, { force: true });
    }
    await this.syncDirectory(dirname(keyFile));
    return true;
  }

  /**
   * Remove staging copies a crash left behind. Each is a second hard link to (or a copy of) the live
   * private key, so none is kept longer than needed. Only called once the current key exists.
   */
  private async removeStaging(dir: string) {
    const names = await readdir(dir).catch((): string[] => []);
    for (const name of names) {
      if (STAGING_FILE.test(name)) {
        await rm(join(dir, name), { force: true });
      }
    }
  }

  /**
   * Create `file` exclusively (O_EXCL, 0600) and flush it to disk. A write or flush that fails removes
   * the file this call created, so it never leaves a partial key behind. A mount that cannot flush at
   * all (some FUSE file systems) is logged once and accepted; any other flush error (EIO) is thrown.
   */
  private async writeKeyExclusive(file: string, pem: string | Buffer) {
    const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    let failure: unknown;
    try {
      await handle.writeFile(pem);
      await handle.sync().catch((error: NodeJS.ErrnoException) => {
        if (!FILE_SYNC_UNSUPPORTED.has(error.code ?? '')) {
          throw error;
        }
        this.flushWasSkipped(file, error.code ?? '');
      });
    } catch (error) {
      failure = error;
    }
    try {
      await handle.close();
    } catch (error) {
      // a close that fails may not have written everything; the first error is the one reported
      failure ??= error;
    }
    if (failure !== undefined) {
      await rm(file, { force: true });
      throw failure;
    }
  }

  /**
   * Flush a directory's entries (a new or renamed key file) to disk. Only the failures that mean the
   * platform or mount cannot flush a directory are accepted (logged once); an I/O error is thrown.
   */
  private async syncDirectory(dir: string) {
    let handle: FileHandle | undefined;
    try {
      handle = await open(dir, constants.O_RDONLY);
      await handle.sync();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!DIRECTORY_SYNC_UNSUPPORTED.has(code)) {
        throw error;
      }
      this.flushWasSkipped(dir, code);
    } finally {
      await handle?.close();
    }
  }

  private flushWasSkipped(target: string, code: string) {
    if (!this.flushSkipped) {
      this.flushSkipped = true;
      this.logger.warn(
        `This file system cannot flush ${target} to disk (${code}); a power failure during a key rotation could lose or cut short the new key`,
      );
    }
  }

  /**
   * Finish a rotation a crash interrupted (FL-155). A key the cloud accepted is renamed to
   * `instance-key.proven.pem` before anything else changes, so on the next load a proven key always
   * replaces the current one (keeping the current one as retiring). A new key whose registration was
   * still in flight (`instance-key.next.pem`) may have reached the cloud, so it is kept as the
   * candidate rather than deleted. The key file itself is only ever replaced by an atomic rename.
   */
  private async recoverRotation(dir: string, now: number) {
    const provenFile = join(dir, PROVEN_KEY_FILE);
    if (await exists(provenFile)) {
      // the marker is written and flushed before the key is set aside, so a crash in between still
      // leaves a rotation asked for (and the earliest marker stands: a recovery never extends the
      // original retire deadline)
      const proven = await this.kidOrSetAside(provenFile, undefined, () => this.markRotationNeeded(dir, now));
      if (proven.kid) {
        await this.finishRotation(dir, {
          rotationId: randomUUID(),
          until: this.hoursFrom(now, RECOVERED_RETIRE_HOURS),
        });
      } else if (proven.setAside) {
        // FL-175: the cloud accepted this key, so it is never swapped in unreadable; the current key keeps
        // working until the cloud stops accepting it, and the next check-in rotates again before then
        this.logger.error(
          `The identity key Frameleaf Cloud accepted in the last rotation cannot be read; it was set aside as ${proven.setAside}. This server keeps its previous key and rotates again at the next check-in.`,
        );
      }
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
   *
   * Only ever called with a proven key that parses. A current key that does not parse (or is missing)
   * is then set aside rather than kept as retiring: the cloud already accepted its successor (FL-175).
   */
  private async finishRotation(dir: string, rotation: { rotationId: string; until: string }): Promise<boolean> {
    const keyFile = join(dir, INSTANCE_KEY_FILE);
    const retiringFile = join(dir, RETIRING_KEY_FILE);
    const pem = await readFile(keyFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      return null;
    });
    let currentKid: string | undefined;
    if (pem) {
      try {
        currentKid = ed25519Thumbprint(publicJwkOf(createPrivateKey(pem)));
      } catch (error) {
        await this.setAside(keyFile, error);
      }
    }
    if (!currentKid) {
      // nothing to retire: an older rotation's retiring key and sidecar must not pass for this one's
      await rm(retiringFile, { force: true });
      await rm(join(dir, RETIRING_META_FILE), { force: true });
    } else {
      const sidecar = join(dir, RETIRING_META_FILE);
      await this.writeSidecar(sidecar, { ...rotation, kid: currentKid });
      await rm(retiringFile, { force: true });
      await link(keyFile, retiringFile).catch(async (error: NodeJS.ErrnoException) => {
        if (NO_HARD_LINK.has(error.code ?? '')) {
          await copyFile(keyFile, retiringFile);
          await this.restrict(retiringFile);
          return;
        }
        ignore(['EEXIST', 'ENOENT'])(error);
      });
    }
    await rename(join(dir, PROVEN_KEY_FILE), keyFile).catch(ignore(['ENOENT']));
    await rm(join(dir, ROTATION_NEEDED_FILE), { force: true });
    // the swap is done and the cloud holds the new key: a flush failing now does not undo the rotation
    await this.syncDirectory(dir).catch((error: unknown) => {
      this.logger.warn(`Could not flush ${dir} after replacing the identity key: ${error}`);
    });
    return !!currentKid;
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
   * rotation can therefore never survive a crash between the swap and the metadata save. The retiring
   * key never signs again, so one that cannot be read or parsed is left out rather than failing the
   * load (FL-175).
   */
  private async retiringOf(dir: string, now: number) {
    const retiringFile = join(dir, RETIRING_KEY_FILE);
    if (!(await exists(retiringFile))) {
      return;
    }
    const sidecarFile = join(dir, RETIRING_META_FILE);
    let kid: string | undefined;
    try {
      ({ kid } = await this.kidOrSetAside(retiringFile, sidecarFile));
    } catch (error) {
      this.logger.warn(
        `Could not read ${retiringFile}, the key the last rotation retired; it was left as it is (${error})`,
      );
      return;
    }
    if (!kid) {
      return;
    }
    type Sidecar = { rotationId?: unknown; kid?: unknown; until?: unknown };
    const sidecar = await readJson<Sidecar>(sidecarFile);
    if (sidecar?.kid === kid && typeof sidecar.rotationId === 'string' && typeof sidecar.until === 'string') {
      return { kid, keyFile: retiringFile, until: sidecar.until, rotationId: sidecar.rotationId };
    }
    const rebuilt = { rotationId: randomUUID(), kid, until: this.hoursFrom(now, RECOVERED_RETIRE_HOURS) };
    await this.writeSidecar(sidecarFile, rebuilt);
    return { kid, keyFile: retiringFile, until: rebuilt.until, rotationId: rebuilt.rotationId };
  }

  /**
   * The in-flight key becomes the candidate; its start time goes in a 0600 sidecar first. A next key
   * that does not parse was cut short by a crash before `rotate` finished flushing it, so (where the
   * file system can flush) before the cloud was asked about it (FL-175): it is set aside and the
   * current key stays. A candidate already here is never overwritten: it is moved to a unique
   * `<file>.superseded-…` name first (FL-178).
   */
  private async makeCandidate(dir: string, now: number) {
    const nextFile = join(dir, NEXT_KEY_FILE);
    const { kid } = await this.kidOrSetAside(nextFile);
    if (!kid) {
      return;
    }
    const candidateFile = join(dir, CANDIDATE_KEY_FILE);
    if (await exists(candidateFile)) {
      // an earlier candidate is still here: the cloud may hold it, so the rename below must not replace
      // it. It is moved to a unique name first and kept for an operator; the newer key is the candidate.
      await this.setAside(
        candidateFile,
        'an earlier candidate key the cloud may hold, replaced by a newer key from an interrupted rotation; kept for an operator',
        { mark: SUPERSEDED_MARK },
      );
    }
    await this.writeSidecar(join(dir, CANDIDATE_META_FILE), { kid, since: new Date(now).toISOString() });
    await rename(nextFile, candidateFile);
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
    // a candidate that no longer parses cannot sign the question to the cloud, so it cannot stay the
    // candidate; it is set aside rather than deleted, since the cloud may hold it (FL-175)
    const { kid } = await this.kidOrSetAside(keyFile, metaFile);
    if (!kid) {
      await rm(metaFile, { force: true });
      return;
    }
    const meta = await readJson<{ kid?: unknown; since?: unknown }>(metaFile);
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
   * Ask for a rotation to be repeated (FL-175): written and flushed, and never replacing an existing
   * marker, whose earlier `since` stands.
   */
  private async markRotationNeeded(dir: string, now: number) {
    const file = join(dir, ROTATION_NEEDED_FILE);
    if (await exists(file)) {
      return;
    }
    await this.writeMarker(file, now);
  }

  private async writeMarker(file: string, now: number) {
    const staging = `${file}.tmp`;
    await rm(staging, { force: true });
    await this.writeKeyExclusive(
      staging,
      JSON.stringify({ since: new Date(now).toISOString(), until: this.hoursFrom(now, RECOVERED_RETIRE_HOURS) }),
    );
    await rename(staging, file);
    await this.syncDirectory(dirname(file));
  }

  /**
   * Whether a rotation must be repeated because its accepted key was set aside (FL-175). A marker that
   * exists but cannot be understood still asks for one; it is rewritten with its window starting now.
   */
  private async rotationNeededOf(dir: string, now: number) {
    const file = join(dir, ROTATION_NEEDED_FILE);
    if (!(await exists(file))) {
      return;
    }
    const marker = await readJson<{ since?: unknown; until?: unknown }>(file);
    if (!marker || !isDateString(marker.since)) {
      await this.writeMarker(file, now);
      return { since: new Date(now).toISOString(), until: this.hoursFrom(now, RECOVERED_RETIRE_HOURS) };
    }
    const until = isDateString(marker.until)
      ? marker.until
      : this.hoursFrom(Date.parse(marker.since), RECOVERED_RETIRE_HOURS);
    return { since: marker.since, until };
  }

  /**
   * Forget a repeat rotation that is no longer possible or needed (FL-175): after linking again (the
   * cloud registered the current key) or unlinking, or once the previous key's window has closed.
   */
  async clearRotationNeeded(dir: string) {
    await rm(join(dir, ROTATION_NEEDED_FILE), { force: true });
  }

  /**
   * The kid of a next, candidate, proven or retiring key (FL-175): `{kid}` for a usable key, `{}`
   * when there is no file, and `{setAside}` when its contents are not an Ed25519 private key. Such a
   * file (a write a crash cut short, or damage) is moved to a unique `<file>.corrupt-…` name and its
   * sidecar removed, so the current key keeps working. Nothing is deleted or moved when the file
   * cannot be read at all (permissions, I/O errors): that error is thrown, because the file may hold a
   * key the cloud knows and the cause is for an operator to fix. The current key never comes through
   * here (see `currentKeyOf`).
   */
  private async kidOrSetAside(
    keyFile: string,
    sidecar?: string,
    beforeSetAside?: () => Promise<void>,
  ): Promise<{ kid?: string; setAside?: string }> {
    const pem = await readFile(keyFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      return null;
    });
    if (!pem) {
      return {};
    }
    try {
      return { kid: ed25519Thumbprint(publicJwkOf(createPrivateKey(pem))) };
    } catch (error) {
      await beforeSetAside?.();
      const setAside = await this.setAside(keyFile, error);
      if (sidecar) {
        await rm(sidecar, { force: true });
      }
      return setAside ? { setAside } : {};
    }
  }

  /**
   * Move a key file that does not parse to a unique `<file>.corrupt-<time>-<random>` name, owner-only,
   * kept for an operator (it may be the only copy of a key the cloud knows). Returns the new path.
   * `mark` names another reason, such as a candidate a newer one replaced (`SUPERSEDED_MARK`).
   */
  private async setAside(file: string, reason: unknown, { mark = SET_ASIDE_MARK }: { mark?: string } = {}) {
    const target = `${file}${mark}${Date.now()}-${randomUUID().slice(0, 8)}`;
    try {
      await rename(file, target);
    } catch (error) {
      ignore(['ENOENT'])(error as NodeJS.ErrnoException);
      return;
    }
    await this.restrict(target);
    this.logger.warn(
      mark === SET_ASIDE_MARK
        ? `Set aside ${file} as ${target}: it is not a usable Frameleaf identity key (${reason})`
        : `Set aside ${file} as ${target}: ${reason}`,
    );
    return target;
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
   * current one (O_EXCL, 0600) and flushed to disk; `prove` receives its public JWK and a signer that
   * still uses the current key, and must register the new key with the cloud. Only when it succeeds
   * does the new key replace the current one; the old key is kept as `instance-key.retiring.pem` until
   * `until`. When `prove` fails, the new key is removed and nothing changes. The caller holds the
   * identity lock and loaded `identity` under it, so any earlier next key is already the candidate: one
   * found here is a rotation under way, and this call stops rather than replace it.
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
    // a candidate may be the key the cloud holds; a lost answer now would replace it (makeCandidate), so
    // it is resolved (promoted or discarded, see the cloud service) before any new rotation (FL-175)
    if (await exists(join(dir, CANDIDATE_KEY_FILE))) {
      throw new Error('A candidate key from an earlier rotation is still open; it must be resolved first');
    }
    const pair = generateKeyPairSync('ed25519');
    try {
      await this.writeKeyExclusive(nextFile, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`A key rotation is already under way (${nextFile} exists)`);
      }
      throw error;
    }
    // flushed before the cloud hears of it: where the file system can flush, a next key that does not
    // parse after a crash was never sent. A flush that fails outright (EIO) stops the rotation here.
    await this.syncDirectory(dir).catch(async (error: unknown) => {
      await rm(nextFile, { force: true });
      throw error;
    });
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

  /**
   * A signer bound to the candidate key, to ask the cloud whether it holds it. The only way a token is
   * ever minted with a key other than the current one (FC-19: a rotation proved by a retiring key is
   * refused once the active key was used), so only `resolveCandidate` in the cloud service calls it.
   */
  async candidateSigner(identity: FrameleafInstanceIdentity): Promise<FrameleafKeySigner> {
    const candidate = identity.candidate;
    if (!candidate) {
      throw new Error('There is no candidate key');
    }
    const signer = this.signerOf(createPrivateKey(await readFile(candidate.keyFile)));
    if (signer.kid !== candidate.kid) {
      throw new Error('The candidate key changed while it was being read');
    }
    return signer;
  }

  /**
   * A signer bound to the current key as last loaded by `loadOrCreate` (FL-178). It keeps that key
   * even when a rotation replaces the current one meanwhile, so a token's client assertion and every
   * DPoP proof for it are always signed by one key. During a recovery after a damaged key (FL-175)
   * this is the previous key, which the cloud sees as retiring.
   */
  currentSigner(): FrameleafKeySigner {
    if (!this.cached) {
      throw new Error('The Frameleaf identity key is not loaded');
    }
    return this.signerOf(this.cached.privateKey);
  }

  private signerOf(privateKey: KeyObject): FrameleafKeySigner {
    const publicJwk = publicJwkOf(privateKey);
    return {
      kid: ed25519Thumbprint(publicJwk),
      publicJwk,
      sign: (header, payload) => this.jws(privateKey, header, payload),
    };
  }

  private async swapIn(
    identity: FrameleafInstanceIdentity,
    privateKey: KeyObject,
    retireHours: number,
    now: number,
  ): Promise<FrameleafInstanceIdentity> {
    const dir = dirname(identity.keyFile);
    const rotation = { rotationId: randomUUID(), until: this.hoursFrom(now, retireHours) };
    const retired = await this.finishRotation(dir, rotation);
    this.cached = { keyFile: identity.keyFile, privateKey };
    const publicJwk = publicJwkOf(privateKey);
    const { candidate: _candidate, rotationNeeded: _rotationNeeded, retiring: _retiring, ...rest } = identity;
    return {
      ...rest,
      kid: ed25519Thumbprint(publicJwk),
      publicJwk,
      ...(retired && { retiring: { kid: identity.kid, keyFile: join(dir, RETIRING_KEY_FILE), ...rotation } }),
    };
  }

  /**
   * Delete the key a rotation retired, once the cloud no longer accepts it. `identity` must have been
   * loaded from `dir` under the identity lock; the key is only removed while the sidecar on disk still
   * names the same rotation, so a newer rotation's retiring key is never removed by an older decision.
   */
  async removeRetired(dir: string, identity: FrameleafInstanceIdentity): Promise<FrameleafInstanceIdentity> {
    const { retiring, ...rest } = identity;
    if (!retiring) {
      return rest;
    }
    const sidecar = await readJson<{ rotationId?: unknown }>(join(dir, RETIRING_META_FILE));
    if (sidecar?.rotationId !== retiring.rotationId) {
      return identity;
    }
    await rm(join(dir, RETIRING_KEY_FILE), { force: true });
    await rm(join(dir, RETIRING_META_FILE), { force: true });
    return rest;
  }

  /** A compact EdDSA JWS over `payload`, signed with the identity key loaded by `loadOrCreate`. */
  signJws(kid: string, payload: Record<string, unknown>, type = 'JWT'): string {
    if (!this.cached) {
      throw new Error('The Frameleaf identity key is not loaded');
    }
    return this.signWith(this.cached.privateKey, kid, payload, type);
  }

  /**
   * FL-177: a compact EdDSA JWS that carries its own public key in the header (`jwk`, RFC 7515
   * section 4.1.3) beside `kid`, its RFC 7638 thumbprint, for a receiver that holds no key for this
   * server yet (a licence activation from a server that was never linked). Signed by `signer` (by
   * default the current key), so a caller that also names the key elsewhere, such as a fingerprint's
   * `jkt`, takes both from the same key snapshot (FL-177 review); the header key always matches the
   * signature.
   */
  signJwsWithPublicKey(
    payload: Record<string, unknown>,
    { signer = this.currentSigner(), type = 'JWT' }: { signer?: FrameleafKeySigner; type?: string } = {},
  ): string {
    return signer.sign({ alg: 'EdDSA', typ: type, kid: signer.kid, jwk: signer.publicJwk }, payload);
  }

  private signWith(privateKey: KeyObject, kid: string, payload: Record<string, unknown>, type = 'JWT') {
    return this.jws(privateKey, { alg: 'EdDSA', typ: type, kid }, payload);
  }

  private jws(privateKey: KeyObject, header: Record<string, unknown>, payload: Record<string, unknown>) {
    const input = jwsSigningInput(header, payload);
    return `${input}.${base64url(sign(null, Buffer.from(input), privateKey))}`;
  }
}
