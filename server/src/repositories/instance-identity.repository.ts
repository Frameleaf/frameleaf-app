import { Injectable } from '@nestjs/common';
import { type KeyObject, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FrameleafInstanceIdentity } from 'src/types.js';
import { base64url, ed25519Thumbprint } from 'src/utils/frameleaf-cloud.js';

/** File name of the private key inside the identity directory. */
export const INSTANCE_KEY_FILE = 'instance-key.pem';

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
    existing: Pick<FrameleafInstanceIdentity, 'instanceId' | 'createdAt'> | null,
  ): Promise<FrameleafInstanceIdentity> {
    const keyFile = join(dir, INSTANCE_KEY_FILE);
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
    return {
      instanceId: !created && existing ? existing.instanceId : randomUUID(),
      kid: ed25519Thumbprint(publicJwk),
      publicJwk,
      keyFile,
      createdAt: !created && existing ? existing.createdAt : new Date().toISOString(),
    };
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
