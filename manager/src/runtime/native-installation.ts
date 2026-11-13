import { z } from 'zod';
import { digest, Refusal } from '../contracts.js';
import type { Store } from '../store.js';
import { SecureInstallationIdSchema } from './native.js';

/**
 * What this native Manager can do beyond the first released protocol. Desktop reads the same list
 * from `frameleaf.nativeCapabilities` in package.json, which is part of the signed package, before
 * it starts Manager; the paired `runtime` reply repeats it.
 */
export const NATIVE_CAPABILITIES = Object.freeze([
  'ports',
] as const);

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const NativeTransition = z
  .object({ operationId: SecureInstallationIdSchema, fromFingerprint: hash })
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

/**
 * Bind this store to the descriptor the supervisor's bootstrap supplies, in one transaction.
 *
 * A first start records it. After that the descriptor must be the stored one, except for:
 * - the database and photo ports, which are the supervisor's configuration, not identity;
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
  } = {},
): void {
  const { transition } = options;
  const fingerprint = digest(descriptor);
  const changed = () => new Refusal('native_installation_changed');
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const raw = store.get('native-installation');
    if (raw === null) {
      // Nothing to move from: a transition against an empty store is not a first start.
      if (transition) throw changed();
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
    // What the stored descriptor becomes before its ports are considered.
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
    // Only the ports may now differ from what was supplied.
    if (
      digest({
        ...base,
        installation: {
          ...base.installation,
          databasePort: descriptor.installation.databasePort,
          apiPort: descriptor.installation.apiPort,
        },
      }) !== fingerprint
    )
      throw changed();
    store.set('native-installation', { fingerprint, descriptor });
    if (transition && !spent)
      store.set(receiptKey!, { ...transition, toFingerprint: fingerprint });
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
}
