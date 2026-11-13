import { verify, X509Certificate } from 'node:crypto';
import { z } from 'zod';
import { digest, Refusal, sha256 } from '../contracts.js';
import type { Store } from '../store.js';
import { SecureInstallationIdSchema } from './native.js';

/**
 * What this native Manager can do beyond the first released protocol. Desktop reads the same list
 * from `frameleaf.nativeCapabilities` in package.json, which is part of the signed package, before
 * it starts Manager; the paired `runtime` reply repeats it.
 */
export const NATIVE_CAPABILITIES = Object.freeze([
  'ports',
  'tls-rotation',
] as const);

/** How long the certificate a rotation replaced may still start this Manager. */
export const NATIVE_TLS_GRACE_MS = 30 * 86_400_000;

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const NativeTransition = z
  .object({ operationId: SecureInstallationIdSchema, fromFingerprint: hash })
  .strict();
/** A handover to a new certificate, signed with the key of the certificate it replaces. */
export const NativeTlsRotation = z
  .object({
    operationId: SecureInstallationIdSchema,
    previousCertificatePem: z.string().min(1).max(8192),
    signature: z
      .string()
      .min(4)
      .max(1024)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
const Grace = z
  .object({
    operationId: SecureInstallationIdSchema,
    previous: hash,
    current: hash,
    at: z.number().int().nonnegative(),
    until: z.number().int().nonnegative(),
  })
  .strict();
const Receipt = NativeTransition.extend({ toFingerprint: hash }).strict();

/** The part of a native descriptor these rules read; the caller's schema owns the rest. */
export type NativeDescriptor = {
  protocolVersion: number;
  name: string;
  tlsCertificatePemSha256: string;
  installation: {
    id: string;
    secureInstallationId: string;
    state: string;
    databasePort: number;
    apiPort: number;
  };
};
type Stored<D> = { fingerprint: string; descriptor: D };

export function nativeTlsRotationMessage(
  installationId: string,
  operationId: string,
  previous: string,
  next: string,
): string {
  return JSON.stringify([
    'frameleaf-manager/tls-rotation/v1',
    installationId,
    operationId,
    previous,
    next,
  ]);
}

/**
 * Whether the handover names exactly the stored certificate and is signed by its key. Anything
 * that cannot be read or checked is a refusal. The replaced certificate may have expired: the key
 * is still held only by the supervisor, and refusing would leave the library unstartable.
 */
function handedOver(
  rotation: z.infer<typeof NativeTlsRotation>,
  installationId: string,
  stored: string,
  next: string,
): boolean {
  try {
    if (sha256(rotation.previousCertificatePem) !== stored || stored === next)
      return false;
    const key = new X509Certificate(rotation.previousCertificatePem).publicKey;
    const signature = Buffer.from(rotation.signature, 'base64');
    if (
      signature.toString('base64') !== rotation.signature ||
      !['ec', 'rsa', 'ed25519'].includes(key.asymmetricKeyType ?? '')
    )
      return false;
    return verify(
      key.asymmetricKeyType === 'ed25519' ? null : 'sha256',
      Buffer.from(
        nativeTlsRotationMessage(
          installationId,
          rotation.operationId,
          stored,
          next,
        ),
      ),
      key,
      signature,
    );
  } catch {
    return false;
  }
}

/**
 * Bind this store to the descriptor the supervisor's bootstrap supplies, in one transaction.
 *
 * A first start records it. After that the descriptor must be the stored one, except for:
 * - the database and photo ports, which are the supervisor's configuration, not identity;
 * - the TLS certificate, when the bootstrap carries a handover signed by the stored
 *   certificate's key, or names the certificate a rotation replaced within its grace period;
 * - the package fields, once, through the existing installation transition.
 *
 * Any change waits for a store with no operation in flight. Everything else is
 * `native_installation_changed`, as before.
 */
export function admitNativeInstallation<D extends NativeDescriptor>(
  store: Store,
  descriptor: D,
  parse: (value: unknown) => Stored<D> | null,
  options: {
    transition?: z.infer<typeof NativeTransition>;
    rotation?: z.infer<typeof NativeTlsRotation>;
    now?: number;
  } = {},
): void {
  const { transition, rotation } = options;
  const now = options.now ?? Date.now();
  const fingerprint = digest(descriptor);
  const changed = () => new Refusal('native_installation_changed');
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const raw = store.get('native-installation');
    if (raw === null) {
      // Nothing to move from: a transition or handover against an empty store is not a first start.
      if (transition || rotation) throw changed();
      store.set('native-installation', { fingerprint, descriptor });
      store.db.exec('COMMIT');
      return;
    }
    const receiptKey = transition
      ? `native-transition:${transition.operationId}`
      : null;
    const prior = receiptKey ? store.get(receiptKey) : null;
    let spent = false;
    if (transition && prior !== null) {
      const receipt = Receipt.safeParse(prior);
      if (
        !receipt.success ||
        receipt.data.fromFingerprint !== transition.fromFingerprint
      )
        throw changed();
      spent = true;
    }
    // An unchanged descriptor with no transition is accepted on its fingerprint alone, as before.
    const same = (raw as { fingerprint?: unknown }).fingerprint === fingerprint;
    const stored = same && !transition ? null : parse(raw);
    if (
      !(same && !transition) &&
      (!stored ||
        digest(stored.descriptor) !== stored.fingerprint ||
        store.get('installation') ||
        store.get('native-library-id') !== descriptor.installation.id)
    )
      throw changed();
    if (same || !stored) {
      // A transition that was never applied cannot explain a store that is already there.
      if (transition && !spent) throw changed();
      store.db.exec('COMMIT');
      return;
    }
    if (
      store.db.prepare('SELECT 1 FROM operations WHERE active=1 LIMIT 1').get()
    )
      throw new Refusal('operation_in_progress');
    const source = stored.descriptor;
    // What the stored descriptor becomes before its ports and certificate are considered.
    let base: NativeDescriptor = source;
    if (transition && !spent) {
      if (
        transition.fromFingerprint === fingerprint ||
        stored.fingerprint !== transition.fromFingerprint ||
        source.protocolVersion !== descriptor.protocolVersion ||
        source.name !== descriptor.name ||
        (['id', 'secureInstallationId', 'state'] as const).some(
          (key) => source.installation[key] !== descriptor.installation[key],
        )
      )
        throw changed();
      base = {
        ...descriptor,
        installation: {
          ...descriptor.installation,
          databasePort: source.installation.databasePort,
          apiPort: source.installation.apiPort,
        },
        tlsCertificatePemSha256: source.tlsCertificatePemSha256,
      };
    }
    const from = base.tlsCertificatePemSha256,
      to = descriptor.tlsCertificatePemSha256;
    let grace: z.infer<typeof Grace> | null | undefined;
    if (from !== to) {
      const replaced = Grace.safeParse(store.get('native-tls-rotation'));
      if (
        rotation &&
        handedOver(rotation, descriptor.installation.id, from, to)
      )
        grace = {
          operationId: rotation.operationId,
          previous: from,
          current: to,
          at: now,
          until: now + NATIVE_TLS_GRACE_MS,
        };
      else if (
        replaced.success &&
        replaced.data.current === from &&
        replaced.data.previous === to &&
        now < replaced.data.until
      )
        // The supervisor went back to the certificate the rotation replaced; that is current again.
        grace = null;
      else throw changed();
    }
    // Only the ports and the certificate may now differ from what was supplied.
    if (
      digest({
        ...base,
        installation: {
          ...base.installation,
          databasePort: descriptor.installation.databasePort,
          apiPort: descriptor.installation.apiPort,
        },
        tlsCertificatePemSha256: to,
      }) !== fingerprint
    )
      throw changed();
    store.set('native-installation', { fingerprint, descriptor });
    if (transition && !spent)
      store.set(receiptKey!, { ...transition, toFingerprint: fingerprint });
    if (grace) store.set('native-tls-rotation', grace);
    else if (grace === null) store.delete('native-tls-rotation');
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
}
