import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ImportDatabase } from 'src/immich-import/types.js';
import { bindDestinationImportPlan } from 'src/library-import/destination-plan.js';
import { parseImportManifest } from 'src/library-import/manifest.js';
import { createImportedOwner, importedOwnerSchema } from 'src/library-import/owners.js';
import { ImportedPassword } from 'src/library-import/passwords.js';
import {
  LibraryImportBinding,
  LibraryImportJournal,
  LibraryImportRefused,
  parseLibraryImportBinding,
} from 'src/library-import/state.js';
import { beginLibraryImportReadback } from 'src/library-import/verification.js';

const id = z.string().min(1).max(1024);
const loginSchema = z.strictObject({
  revision: id,
  snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
  accountEnabled: z.boolean(),
  passwordLoginEnabled: z.boolean(),
  secondFactorRequired: z.boolean(),
  externalIdentityRequired: z.boolean(),
  ownedLibraryAccess: z.enum(['full', 'restricted', 'none']),
  otherRestrictions: z.enum(['none', 'present']),
});
const restrictionSchema = z.enum([
  'account-disabled',
  'password-login-disabled',
  'second-factor-required',
  'external-identity-required',
  'restricted-library-access',
  'other-source-restrictions',
]);
const sourceRestrictions = (login: z.infer<typeof loginSchema>): z.infer<typeof restrictionSchema>[] => {
  const reasons: z.infer<typeof restrictionSchema>[] = [];
  if (!login.accountEnabled) reasons.push('account-disabled');
  if (!login.passwordLoginEnabled) reasons.push('password-login-disabled');
  if (login.secondFactorRequired) reasons.push('second-factor-required');
  if (login.externalIdentityRequired) reasons.push('external-identity-required');
  if (login.ownedLibraryAccess !== 'full') reasons.push('restricted-library-access');
  if (login.otherRestrictions !== 'none') reasons.push('other-source-restrictions');
  return reasons;
};
const intentSchema = z
  .strictObject({
    sourceUserId: id,
    email: z
      .email()
      .max(254)
      .transform((value) => value.toLowerCase()),
    login: loginSchema,
    disposition: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('preserve') }),
      z.strictObject({
        kind: z.literal('claim'),
        reason: z.enum(['unsupported-local-verifier', 'no-local-verifier']),
        claimPermitted: z.literal(true),
      }),
      z.strictObject({
        kind: z.literal('restricted'),
        reasons: z.array(restrictionSchema).min(1),
        acknowledged: z.literal(true),
        credential: z.enum(['preserve', 'unavailable']),
      }),
    ]),
  })
  .superRefine((value, ctx) => {
    const reasons = sourceRestrictions(value.login);
    const matches =
      value.disposition.kind === 'restricted'
        ? reasons.length > 0 &&
          reasons.length === value.disposition.reasons.length &&
          reasons.every(
            (reason) => value.disposition.kind === 'restricted' && value.disposition.reasons.includes(reason),
          )
        : reasons.length === 0;
    if (!matches)
      ctx.addIssue({ code: 'custom', message: 'Source account restrictions do not match the destination policy' });
  })
  .transform((value) =>
    value.disposition.kind === 'restricted'
      ? { ...value, disposition: { ...value.disposition, reasons: sourceRestrictions(value.login) } }
      : value,
  );

type Context = { binding: LibraryImportBinding; manifest: unknown; plan: unknown; destinationId: string };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const refuse = (code: string): never => {
  throw new LibraryImportRefused(code);
};
export const parseImportedOwnerIntent = (input: unknown) => {
  const parsed = intentSchema.safeParse(input);
  if (!parsed.success) return refuse('OWNER_INTENT_INVALID');
  return parsed.data;
};
const boundOwners = (context: Context) => {
  const binding = parseLibraryImportBinding(context.binding);
  const plan = bindDestinationImportPlan(context.plan, binding, context.manifest, context.destinationId);
  const manifest = parseImportManifest(context.manifest);
  const names = new Map(manifest.users.map((user) => [user.id, user.name]));
  return {
    binding,
    owners: new Map(
      plan.owners.map((owner) => [
        owner.sourceId,
        { destinationId: owner.destinationId.toLowerCase(), name: names.get(owner.sourceId)! },
      ]),
    ),
  };
};
const prepareOwner = (bound: ReturnType<typeof boundOwners>, input: unknown, credential?: ImportedPassword) => {
  const intent = parseImportedOwnerIntent(input);
  const mapped = bound.owners.get(intent.sourceUserId);
  if (!mapped) return refuse('OWNER_SOURCE_MISSING');
  if (intent.login.revision !== bound.binding.source.revision) return refuse('OWNER_QUALIFICATION_CHANGED');
  const restricted = intent.disposition.kind === 'restricted';
  const preserve =
    intent.disposition.kind === 'preserve' ||
    (intent.disposition.kind === 'restricted' && intent.disposition.credential === 'preserve');
  if (preserve ? !credential : credential !== undefined) return refuse('OWNER_CREDENTIAL_DISPOSITION_MISMATCH');
  if (
    credential &&
    (!(credential instanceof ImportedPassword) ||
      credential.operationId !== bound.binding.operationId ||
      credential.sourceUserId !== intent.sourceUserId ||
      credential.destinationUserId !== mapped.destinationId)
  )
    return refuse('OWNER_CREDENTIAL_MISMATCH');
  const parsedOwner = importedOwnerSchema.safeParse({
    operationId: bound.binding.operationId,
    sourceUserId: intent.sourceUserId,
    destinationUserId: mapped.destinationId,
    email: intent.email,
    name: mapped.name,
  });
  if (!parsedOwner.success) return refuse('OWNER_INTENT_INVALID');
  const owner = parsedOwner.data;
  // The verifier participates only in this private journal digest, never in the public report.
  const recordSha256 = digest({
    owner,
    login: intent.login,
    disposition: intent.disposition,
    password: credential?.forImport() ?? null,
  });
  return { owner, intent, credential, claim: intent.disposition.kind !== 'preserve', restricted, recordSha256 };
};
const prepareOwnerInventory = (bound: ReturnType<typeof boundOwners>, inventory: unknown) => {
  const parsed = z
    .array(
      z.strictObject({
        intent: z.unknown(),
        credential: z.custom<ImportedPassword>((value) => value instanceof ImportedPassword).optional(),
      }),
    )
    .safeParse(inventory);
  if (!parsed.success || parsed.data.length !== bound.owners.size) return refuse('OWNER_RECONCILIATION_MISMATCH');
  const expected = parsed.data.map(({ intent, credential }) => prepareOwner(bound, intent, credential));
  if (new Set(expected.map((item) => item.owner.sourceUserId)).size !== bound.owners.size)
    return refuse('OWNER_RECONCILIATION_MISMATCH');
  return expected;
};

/** Private canonical inputs, not evidence that source login restrictions have been independently qualified. */
export const prepareImportedOwners = (context: Context, inventory: unknown) =>
  prepareOwnerInventory(boundOwners(context), inventory);

/** Internal destination primitive: adapters/controller must independently qualify and retain private source login evidence. */
export class CanonicalOwnerWriter {
  private readonly bound: ReturnType<typeof boundOwners>;
  constructor(
    private readonly db: ImportDatabase,
    context: Context,
  ) {
    this.bound = boundOwners(context);
  }
  async write(input: unknown, credential?: ImportedPassword): Promise<string> {
    const prepared = prepareOwner(this.bound, input, credential);
    try {
      return await new LibraryImportJournal(this.db).apply(
        this.bound.binding,
        {
          kind: 'owner',
          sourceId: prepared.owner.sourceUserId,
          destinationId: prepared.owner.destinationUserId,
          recordSha256: prepared.recordSha256,
        },
        async (tx) => {
          if (
            (await tx.query('SELECT 1 FROM public."user" WHERE lower(email)=$1 LIMIT 1', [prepared.owner.email]))
              .length > 0
          )
            return refuse('OWNER_EMAIL_COLLISION');
          await createImportedOwner(tx, prepared.owner, prepared.credential, prepared.restricted);
        },
      );
    } catch (error) {
      if (error instanceof LibraryImportRefused) throw error;
      if (error instanceof Error && error.message === 'Library import refused: DESTINATION_ADMIN_REQUIRED')
        return refuse('DESTINATION_ADMIN_REQUIRED');
      throw new LibraryImportRefused('OWNER_WRITE_FAILED');
    }
  }
}
const sameCredential = (actual: unknown, expected: string | null) => {
  if (expected === null) return actual === null;
  if (typeof actual !== 'string') return false;
  const left = Buffer.from(actual),
    right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Owner evidence only: source qualification, other preservation records and activation remain separate requirements. */
export async function reconcileImportedOwners(db: ImportDatabase, context: Context, inventory: unknown) {
  const bound = boundOwners(context);
  const expected = prepareOwnerInventory(bound, inventory);
  try {
    return await db.transaction(async (tx) => {
      await beginLibraryImportReadback(tx);
      const { run } = await new LibraryImportJournal(tx).status();
      if (!run || JSON.stringify(run.binding) !== JSON.stringify(bound.binding))
        return refuse('IMPORT_BINDING_CHANGED');
      if (run.status !== 'verifying') return refuse('IMPORT_NOT_VERIFYING');
      const mappings = await tx.query(
        `SELECT source_id,destination_id::text,record_sha256 FROM public.frameleaf_library_import_mapping
        WHERE operation_id=$1::uuid AND entity_kind='owner'`,
        [bound.binding.operationId],
      );
      const bySource = new Map(mappings.map((row) => [row.source_id, row]));
      if (
        mappings.length !== expected.length ||
        expected.some(({ owner, recordSha256 }) => {
          const row = bySource.get(owner.sourceUserId);
          return row?.destination_id !== owner.destinationUserId || row.record_sha256 !== recordSha256;
        })
      )
        return refuse('OWNER_RECONCILIATION_MISMATCH');
      const actual =
        await tx.query(`SELECT id::text,email,name,password,"pinCode","oauthId","isAdmin",status,"deletedAt",
        "clusterGroupId"::text,"importClaimPending","shouldChangePassword","passwordLinkHash","passwordLinkExpiresAt",
        "profileImagePath","profileImageAssetId"::text,"avatarColor","storageLabel","uploadsPaused","quotaSizeInBytes"::text FROM public."user" ORDER BY id`);
      const byId = new Map(actual.map((row) => [row.id, row]));
      const ownerIds = expected.map(({ owner }) => owner.destinationUserId);
      const imported = new Set(ownerIds);
      const administrators = actual.filter((row) => !imported.has(String(row.id)));
      if (
        actual.length !== expected.length + 1 ||
        administrators.length !== 1 ||
        administrators[0].isAdmin !== true ||
        administrators[0].status !== 'active' ||
        administrators[0].deletedAt !== null ||
        administrators[0].importClaimPending !== false ||
        imported.has(String(administrators[0].clusterGroupId))
      )
        return refuse('OWNER_RECONCILIATION_MISMATCH');
      const groups = await tx.query('SELECT id::text,name FROM public.cluster_group');
      const groupById = new Map(groups.map((row) => [row.id, row]));
      if (groups.length !== expected.length + 1 || !groupById.has(administrators[0].clusterGroupId))
        return refuse('OWNER_RECONCILIATION_MISMATCH');
      const safeRecords = expected
        .map(({ owner, credential, claim, restricted }) => {
          const row = byId.get(owner.destinationUserId);
          if (
            !row ||
            row.email !== owner.email ||
            row.name !== owner.name ||
            !sameCredential(row.password, credential?.forImport() ?? null) ||
            row.clusterGroupId !== owner.destinationUserId ||
            groupById.get(row.clusterGroupId)?.name !== null ||
            row.isAdmin !== false ||
            row.status !== 'active' ||
            row.deletedAt !== null ||
            row.importClaimPending !== claim ||
            row.shouldChangePassword !== !credential ||
            row.pinCode !== null ||
            row.oauthId !== null ||
            row.passwordLinkHash !== null ||
            row.passwordLinkExpiresAt !== null ||
            row.profileImagePath !== '' ||
            row.profileImageAssetId !== null ||
            row.avatarColor !== null ||
            row.storageLabel !== null ||
            row.uploadsPaused !== false ||
            row.quotaSizeInBytes !== null
          )
            return refuse('OWNER_RECONCILIATION_MISMATCH');
          return {
            id: owner.destinationUserId,
            email: owner.email,
            name: owner.name,
            clusterGroupId: row.clusterGroupId,
            claimPending: claim,
            ...(restricted ? { loginRestricted: true } : {}),
          };
        })
        .sort((a, b) => a.id.localeCompare(b.id));
      // Imported users cannot establish authentication or partner sharing; albums have separate manifest reconciliation.
      const artifacts = await tx.query(
        `SELECT 1 FROM public.session WHERE "userId"=ANY($1::uuid[])
        UNION ALL SELECT 1 FROM public.api_key WHERE "userId"=ANY($1::uuid[])
        UNION ALL SELECT 1 FROM public.frameleaf_account_link
        UNION ALL SELECT 1 FROM public.frameleaf_session
        UNION ALL SELECT 1 FROM public.user_metadata WHERE "userId"=ANY($1::uuid[])
        UNION ALL SELECT 1 FROM public.user_preference_history WHERE "userId"=ANY($1::uuid[])
        UNION ALL SELECT 1 FROM public.shared_link WHERE "userId"=ANY($1::uuid[])
        UNION ALL SELECT 1 FROM public.partner
          WHERE "sharedById"=ANY($1::uuid[]) OR "sharedWithId"=ANY($1::uuid[]) LIMIT 1`,
        [ownerIds],
      );
      if (artifacts.length > 0) return refuse('OWNER_RECONCILIATION_MISMATCH');
      return {
        format: 'frameleaf-owner-reconciliation' as const,
        version: 1 as const,
        operationId: bound.binding.operationId,
        manifestSha256: bound.binding.manifestSha256,
        planSha256: bound.binding.planSha256,
        owners: expected.length,
        preservedPasswords: expected.filter((item) => !!item.credential).length,
        claimPending: expected.filter((item) => item.claim).length,
        ...(expected.some((item) => item.restricted)
          ? {
              restricted: {
                owners: expected.filter((item) => item.restricted).length,
                preservedPasswords: expected.filter((item) => item.restricted && item.credential).length,
              },
            }
          : {}),
        sha256: digest(safeRecords),
      };
    });
  } catch (error) {
    if (error instanceof LibraryImportRefused) throw error;
    throw new LibraryImportRefused('OWNER_RECONCILIATION_FAILED');
  }
}
