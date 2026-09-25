import { Injectable } from '@nestjs/common';
import { type KeyObject, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { constants } from 'node:fs';
import { access, link, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import type { FrameleafInstanceIdentity } from 'src/types.js';
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
    await this.recoverRotation(dir);
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
    const retiring = created ? undefined : await this.retiringOf(dir, existing?.retiring, now);
    return {
      instanceId: !created && existing ? existing.instanceId : uuidv7(),
      kid: ed25519Thumbprint(publicJwk),
      publicJwk,
      keyFile,
      createdAt: !created && existing ? existing.createdAt : new Date().toISOString(),
      ...(retiring && { retiring }),
    };
  }

  /**
   * Finish or undo a rotation a crash interrupted (FL-155). A key the cloud accepted is renamed to
   * `instance-key.proven.pem` before anything else changes, so on the next load a proven key always
   * replaces the current one (keeping the current one as retiring), and a key that was never proven
   * is discarded. The key file itself is only ever replaced by an atomic rename.
   */
  private async recoverRotation(dir: string) {
    if (await exists(join(dir, PROVEN_KEY_FILE))) {
      await this.finishRotation(dir);
    }
    await rm(join(dir, NEXT_KEY_FILE), { force: true });
  }

  /** Keep the current key as retiring (a hard link), then atomically put the proven key in place. */
  private async finishRotation(dir: string) {
    const keyFile = join(dir, INSTANCE_KEY_FILE);
    const retiringFile = join(dir, RETIRING_KEY_FILE);
    await rm(retiringFile, { force: true });
    await link(keyFile, retiringFile).catch(ignore(['EEXIST', 'ENOENT']));
    await rename(join(dir, PROVEN_KEY_FILE), keyFile).catch(ignore(['ENOENT']));
  }

  /** The retiring key's metadata: kept when known, rebuilt when a recovered rotation left one. */
  private async retiringOf(dir: string, known: FrameleafInstanceIdentity['retiring'] | undefined, now: number) {
    const retiringFile = join(dir, RETIRING_KEY_FILE);
    if (!(await exists(retiringFile))) {
      return;
    }
    if (known?.keyFile === retiringFile) {
      return known;
    }
    const retired = createPrivateKey(await readFile(retiringFile));
    return {
      kid: ed25519Thumbprint(publicJwkOf(retired)),
      keyFile: retiringFile,
      until: new Date(now + RECOVERED_RETIRE_HOURS * 60 * 60 * 1000).toISOString(),
    };
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
  ): Promise<FrameleafInstanceIdentity> {
    if (!this.cached || this.cached.keyFile !== identity.keyFile) {
      throw new Error('The Frameleaf identity key is not loaded');
    }
    const dir = dirname(identity.keyFile);
    const nextFile = join(dir, NEXT_KEY_FILE);
    const retiringFile = join(dir, RETIRING_KEY_FILE);
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
      await rm(nextFile, { force: true });
      throw error;
    }
    // accepted by the cloud: from here a crash finishes the rotation on the next load
    await rename(nextFile, join(dir, PROVEN_KEY_FILE));
    await this.finishRotation(dir);
    this.cached = { keyFile: identity.keyFile, privateKey: pair.privateKey };
    return {
      ...identity,
      kid,
      publicJwk,
      retiring: {
        kid: identity.kid,
        keyFile: retiringFile,
        until: new Date(now + retireHours * 60 * 60 * 1000).toISOString(),
      },
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
    const header = base64url(JSON.stringify({ alg: 'EdDSA', typ: type, kid }));
    const body = base64url(JSON.stringify(payload));
    const signature = sign(null, Buffer.from(`${header}.${body}`), this.cached.privateKey);
    return `${header}.${body}.${base64url(signature)}`;
  }
}
