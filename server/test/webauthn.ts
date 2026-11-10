import { type KeyObject, createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

/**
 * FL-836: a software passkey for tests. It answers the server's real WebAuthn options the way a browser
 * and an authenticator would: a `none` attestation with an ES256 key, and signed assertions with a
 * signature count, so the server's real verification (@simplewebauthn/server) runs in unit and e2e tests.
 */

type Cbor = number | string | Uint8Array | Cbor[] | Map<Cbor, Cbor>;

const head = (major: number, length: number): Buffer => {
  if (length < 24) {
    return Buffer.from([(major << 5) | length]);
  }
  if (length < 256) {
    return Buffer.from([(major << 5) | 24, length]);
  }
  const buffer = Buffer.alloc(3);
  buffer[0] = (major << 5) | 25;
  buffer.writeUInt16BE(length, 1);
  return buffer;
};

const cbor = (value: Cbor): Buffer => {
  if (typeof value === 'number') {
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value === 'string') {
    const text = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, text.length), text]);
  }
  if (value instanceof Uint8Array) {
    return Buffer.concat([head(2, value.length), value]);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([head(4, value.length), ...value.map((item) => cbor(item))]);
  }
  return Buffer.concat([head(5, value.size), ...[...value].flatMap(([key, item]) => [cbor(key), cbor(item)])]);
};

const b64url = (value: Uint8Array | string) => Buffer.from(value).toString('base64url');
const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest();

/** Flags: user present, user verified, attested credential data. */
const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

export type SoftPasskeyOptions = { origin: string; userVerified?: boolean; aaguid?: string };

export class SoftPasskey {
  private readonly privateKey: KeyObject;
  private readonly x: Buffer;
  private readonly y: Buffer;
  readonly credentialId = randomBytes(16);
  counter = 0;
  /** The user handle the server gave when the passkey was made. */
  userHandle?: string;

  constructor(private readonly config: SoftPasskeyOptions) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.x = Buffer.from(jwk.x!, 'base64url');
    this.y = Buffer.from(jwk.y!, 'base64url');
  }

  private clientData(type: string, challenge: string, origin = this.config.origin) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  private flags() {
    return UP | (this.config.userVerified === false ? 0 : UV);
  }

  private counterBytes() {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(this.counter);
    return buffer;
  }

  get id() {
    return b64url(this.credentialId);
  }

  /** The browser's answer to registration options (`navigator.credentials.create`). */
  register(options: Record<string, unknown>, origin?: string) {
    const rp = options.rp as { id: string };
    const user = options.user as { id: string };
    this.userHandle = user.id;
    const aaguid = Buffer.from(
      (this.config.aaguid ?? '00000000-0000-0000-0000-000000000000').replaceAll('-', ''),
      'hex',
    );
    const coseKey = cbor(
      new Map<Cbor, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, this.x],
        [-3, this.y],
      ]),
    );
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      sha256(rp.id),
      Buffer.from([this.flags() | AT]),
      this.counterBytes(),
      aaguid,
      idLength,
      this.credentialId,
      coseKey,
    ]);
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(this.clientData('webauthn.create', options.challenge as string, origin)),
        attestationObject: b64url(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /** The browser's answer to sign-in options (`navigator.credentials.get`); the count goes up by one. */
  signIn(options: Record<string, unknown>, { origin, counter }: { origin?: string; counter?: number } = {}) {
    this.counter = counter ?? this.counter + 1;
    const authData = Buffer.concat([sha256(options.rpId as string), Buffer.from([this.flags()]), this.counterBytes()]);
    const clientDataJSON = this.clientData('webauthn.get', options.challenge as string, origin);
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), this.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        userHandle: this.userHandle,
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }
}
