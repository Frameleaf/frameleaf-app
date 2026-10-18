import {
  createPublicKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify,
} from 'node:crypto';
import { z } from 'zod';
import { digest, Refusal, sha256 } from './contracts.js';
import { Security } from './security.js';
import { Store } from './store.js';

const Scope = z.enum([
  'status',
  'start',
  'stop',
  'restart',
  'backup',
  'update',
  'restore',
  'move-library',
]);
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const Details = z
  .object({
    deviceId: uuid,
    installationId: z.string().regex(/^[a-f0-9]{12}$/),
    publicKey: z
      .string()
      .refine(
        (value) =>
          value.length === 44 &&
          Buffer.from(value, 'base64').length === 32 &&
          Buffer.from(value, 'base64').toString('base64') === value,
      ),
    scopes: z
      .array(Scope)
      .min(1)
      .max(8)
      .refine((values) => new Set(values).size === values.length),
  })
  .strict();
const Identity = z.object({ id: uuid, origin: z.string().url() }).strict();
const Pairing = Details.extend({
  pairingId: uuid,
  managerId: uuid,
  origin: z.string().url(),
  secret: hex,
  approvedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
}).strict();
const Pending = Pairing.omit({ secret: true })
  .extend({ secretHash: hex, epoch: hex })
  .strict();
const Grant = Details.extend({
  id: uuid,
  tokenHash: hex,
  epoch: hex,
  expiresAt: z.number().int().nonnegative(),
  recentUntil: z.number().int().nonnegative(),
}).strict();
const Proof = z
  .object({
    protocolVersion: z.literal(1),
    managerId: uuid,
    grantId: uuid,
    deviceId: uuid,
    token: hex,
    timestamp: z.number().int().nonnegative(),
    nonce: uuid,
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  })
  .strict();
const Target = z
  .object({
    installationId: Details.shape.installationId,
    scope: Scope,
    method: z.enum(['GET', 'POST']),
    path: z.string().regex(/^\/manager-api\/desktop\/[a-z-]+$/),
    bodySha256: hex,
  })
  .strict();
type ManagerIdentity = z.infer<typeof Identity>;
type PairingApproval = z.infer<typeof Pairing>;
type Granted = z.infer<typeof Grant>;
type RequestProof = Omit<z.infer<typeof Proof>, 'signature'>;
type RequestTarget = {
  installationId: string;
  scope: string;
  method: string;
  path: string;
  bodySha256: string;
};
const WINDOW = 60_000,
  RECENT = 300_000,
  LIFETIME = 30 * 86_400_000;
const token = () => randomBytes(32).toString('hex');
const same = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
function signed(key: string, signature: string, message: string): boolean {
  try {
    const publicKey = createPublicKey({
      format: 'der',
      type: 'spki',
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(key, 'base64'),
      ]),
    });
    return verify(
      null,
      Buffer.from(message),
      publicKey,
      Buffer.from(signature, 'base64'),
    );
  } catch {
    return false;
  }
}
export function pairingMessage(approval: PairingApproval): string {
  return JSON.stringify([
    'frameleaf-manager/pair/v1',
    approval.managerId,
    approval.origin,
    approval.pairingId,
    approval.deviceId,
    approval.installationId,
    approval.publicKey,
    approval.scopes,
    approval.secret,
    approval.approvedAt,
    approval.expiresAt,
  ]);
}
export function requestMessage(
  identity: ManagerIdentity,
  proof: RequestProof,
  target: RequestTarget,
): string {
  return JSON.stringify([
    'frameleaf-manager/request/v1',
    identity.id,
    identity.origin,
    proof.grantId,
    proof.deviceId,
    target.installationId,
    target.scope,
    target.method,
    target.path,
    target.bodySha256,
    proof.timestamp,
    proof.nonce,
    proof.token,
  ]);
}
function publicGrant(grant: Granted) {
  const { tokenHash, epoch, publicKey, ...safe } = grant;
  return safe;
}

/** Independent Manager authority: photo sessions and ML credentials never mint these grants. */
export class DesktopGrants {
  readonly identity: Readonly<ManagerIdentity>;
  constructor(
    private store: Store,
    private security: Security,
  ) {
    store.createOnce('desktop-manager-identity', {
      id: randomUUID(),
      origin: security.origin,
    });
    const parsed = Identity.safeParse(store.get('desktop-manager-identity'));
    if (!parsed.success || parsed.data.origin !== security.origin)
      throw new Refusal('desktop_manager_identity_changed');
    this.identity = Object.freeze(parsed.data);
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS desktop_pairings (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS desktop_grants (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS desktop_nonces (grant_id TEXT NOT NULL, nonce TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(grant_id,nonce));`);
  }
  private transaction<T>(work: () => T): T {
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.store.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
  }
  private epoch(): string {
    return digest(this.store.get('administrator'));
  }
  async approve(password: string, input: unknown): Promise<PairingApproval> {
    const details = Details.safeParse(input);
    if (!details.success) throw new Refusal('desktop_pairing_invalid', 400);
    const admin = await this.security.confirm(password);
    return this.transaction(() => {
      if (this.epoch() !== digest(admin))
        throw new Refusal('invalid_credentials', 401);
      const now = Date.now();
      const approval = {
        ...details.data,
        pairingId: randomUUID(),
        managerId: this.identity.id,
        origin: this.identity.origin,
        secret: token(),
        approvedAt: now,
        expiresAt: now + RECENT,
      };
      const { secret, ...safe } = approval;
      this.store.db.prepare('INSERT INTO desktop_pairings VALUES (?,?)').run(
        approval.pairingId,
        JSON.stringify({
          ...safe,
          secretHash: sha256(secret),
          epoch: this.epoch(),
        }),
      );
      return approval;
    });
  }
  redeem(input: unknown) {
    const parsed = z
      .object({
        pairingId: uuid,
        secret: hex,
        signature: Proof.shape.signature,
      })
      .strict()
      .safeParse(input);
    if (!parsed.success) throw new Refusal('desktop_pairing_invalid', 401);
    return this.transaction(() => {
      const row = this.store.db
        .prepare('SELECT value FROM desktop_pairings WHERE id=?')
        .get(parsed.data.pairingId) as { value: string } | undefined;
      const pending = Pending.safeParse(row ? JSON.parse(row.value) : null);
      const now = Date.now();
      if (
        !pending.success ||
        pending.data.epoch !== this.epoch() ||
        pending.data.expiresAt <= now ||
        pending.data.approvedAt > now
      )
        throw new Refusal('desktop_pairing_unavailable', 401);
      const { secretHash, epoch, ...details } = pending.data;
      if (
        !same(secretHash, sha256(parsed.data.secret)) ||
        !signed(
          details.publicKey,
          parsed.data.signature,
          pairingMessage({ ...details, secret: parsed.data.secret }),
        )
      )
        throw new Refusal('desktop_pairing_invalid', 401);
      const secret = token();
      const grant: Granted = {
        id: randomUUID(),
        deviceId: details.deviceId,
        installationId: details.installationId,
        publicKey: details.publicKey,
        scopes: details.scopes,
        tokenHash: sha256(secret),
        epoch,
        expiresAt: now + LIFETIME,
        recentUntil: details.approvedAt + RECENT,
      };
      this.store.db
        .prepare('INSERT INTO desktop_grants VALUES (?,?)')
        .run(grant.id, JSON.stringify(grant));
      this.store.db
        .prepare('DELETE FROM desktop_pairings WHERE id=?')
        .run(details.pairingId);
      return {
        ...publicGrant(grant),
        token: secret,
        managerId: this.identity.id,
        origin: this.identity.origin,
      };
    });
  }
  private current(id: string): Granted {
    const row = this.store.db
      .prepare('SELECT value FROM desktop_grants WHERE id=?')
      .get(id) as { value: string } | undefined;
    const parsed = Grant.safeParse(row ? JSON.parse(row.value) : null);
    if (
      !parsed.success ||
      parsed.data.epoch !== this.epoch() ||
      parsed.data.expiresAt <= Date.now() ||
      parsed.data.expiresAt - LIFETIME > Date.now()
    )
      throw new Refusal('desktop_grant_invalid', 401);
    return parsed.data;
  }
  authorize(input: unknown, expected: RequestTarget) {
    const proof = Proof.safeParse(input),
      target = Target.safeParse(expected);
    if (!proof.success || !target.success)
      throw new Refusal('desktop_grant_invalid', 401);
    return this.transaction(() => {
      const grant = this.current(proof.data.grantId),
        now = Date.now();
      if (
        proof.data.managerId !== this.identity.id ||
        proof.data.deviceId !== grant.deviceId ||
        Math.abs(proof.data.timestamp - now) > WINDOW ||
        !same(grant.tokenHash, sha256(proof.data.token))
      )
        throw new Refusal('desktop_grant_invalid', 401);
      if (target.data.installationId !== grant.installationId)
        throw new Refusal('desktop_grant_installation_changed', 403);
      if (!grant.scopes.includes(target.data.scope))
        throw new Refusal('desktop_grant_scope_denied', 403);
      if (
        !signed(
          grant.publicKey,
          proof.data.signature,
          requestMessage(this.identity, proof.data, target.data),
        )
      )
        throw new Refusal('desktop_grant_invalid', 401);
      if (
        !['status', 'start'].includes(target.data.scope) &&
        (grant.recentUntil <= now || grant.recentUntil - RECENT > now)
      )
        throw new Refusal('desktop_recent_auth_required', 401);
      this.store.db
        .prepare('DELETE FROM desktop_nonces WHERE expires < ?')
        .run(now);
      const inserted = this.store.db
        .prepare('INSERT OR IGNORE INTO desktop_nonces VALUES (?,?,?)')
        .run(grant.id, proof.data.nonce, now + 2 * WINDOW);
      if (inserted.changes !== 1)
        throw new Refusal('desktop_request_replayed', 409);
      return publicGrant(grant);
    });
  }
  async reauthenticate(password: string, id: string): Promise<void> {
    const admin = await this.security.confirm(password);
    this.transaction(() => {
      if (this.epoch() !== digest(admin))
        throw new Refusal('invalid_credentials', 401);
      const grant = this.current(id);
      grant.recentUntil = Date.now() + RECENT;
      this.store.db
        .prepare('UPDATE desktop_grants SET value=? WHERE id=?')
        .run(JSON.stringify(grant), id);
    });
  }
  async revoke(password: string, id: string): Promise<void> {
    const admin = await this.security.confirm(password);
    this.transaction(() => {
      if (this.epoch() !== digest(admin))
        throw new Refusal('invalid_credentials', 401);
      this.store.db.prepare('DELETE FROM desktop_grants WHERE id=?').run(id);
      this.store.db
        .prepare('DELETE FROM desktop_nonces WHERE grant_id=?')
        .run(id);
    });
  }
  list() {
    return (
      this.store.db.prepare('SELECT id FROM desktop_grants').all() as {
        id: string;
      }[]
    ).flatMap(({ id }) => {
      try {
        return [publicGrant(this.current(id))];
      } catch (error) {
        if (error instanceof Refusal) return [];
        throw error;
      }
    });
  }
}
