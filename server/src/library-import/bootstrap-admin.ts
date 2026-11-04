import { compare, hash } from 'bcrypt';
import { z } from 'zod';
import { SALT_ROUNDS } from 'src/constants.js';
import { MIN_PASSWORD_LENGTH } from 'src/dtos/auth.dto.js';
import { AdminAuditAction } from 'src/enum.js';
import { assertCanonicalDestination } from 'src/immich-import/destination-schema.js';
import { type ImportDatabase, ImportRefused } from 'src/immich-import/types.js';
import { assertFreshImportDestination } from 'src/library-import/admission.js';
import { LIBRARY_IMPORT_LOCK } from 'src/library-import/lock.js';
import { LibraryImportRefused } from 'src/library-import/state.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const adminSchema = z.strictObject({
  operationId: uuid,
  destinationId: uuid,
  userId: uuid,
  email: z
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
  name: z.string().trim().min(1).max(200),
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH)
    .refine((value) => Buffer.byteLength(value) <= 72 && !value.includes('\0')),
});

/** Offline bootstrap for a reviewed fresh destination. The caller owns source and operation authority. */
export async function ensureImportBootstrapAdmin(db: ImportDatabase, input: unknown): Promise<string> {
  const parsed = adminSchema.safeParse(input);
  if (!parsed.success) throw new LibraryImportRefused('IMPORT_BOOTSTRAP_ADMIN_INVALID');
  const { operationId, destinationId, userId, email, name, password } = parsed.data;
  const detail = `library-import-bootstrap:${operationId}:${destinationId}`;
  try {
    return await db.transaction(async (session) => {
      const [lock] = await session.query('SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired', [
        LIBRARY_IMPORT_LOCK,
      ]);
      if (!lock?.acquired) throw new LibraryImportRefused('IMPORT_ALREADY_RUNNING');
      await assertCanonicalDestination(session);
      const [existing] = await session.query(
        `SELECT u.id::text,u.email,u.name,u.password
        FROM public."user" u JOIN public.admin_audit_event a
          ON a."userId"=u.id AND a."actorId"=u.id
        WHERE u.id=$1::uuid AND u."isAdmin" AND u.status='active' AND u."deletedAt" IS NULL
          AND NOT u."importClaimPending" AND u."importOperationId" IS NULL
          AND a.action=$2 AND a.detail=$3 LIMIT 1`,
        [userId, AdminAuditAction.AccountCreated, detail],
      );
      if (existing) {
        await assertFreshImportDestination(session, { allowBootstrapAdmin: true });
        if (
          existing.email !== email ||
          existing.name !== name ||
          typeof existing.password !== 'string' ||
          !(await compare(password, existing.password))
        )
          throw new LibraryImportRefused('IMPORT_BOOTSTRAP_ADMIN_CHANGED');
        return userId;
      }
      await assertFreshImportDestination(session);
      const passwordHash = await hash(password, SALT_ROUNDS);
      await session.query(
        `WITH bootstrap_group AS (INSERT INTO public.cluster_group (id) VALUES ($1::uuid) RETURNING id),
        bootstrap_user AS (
          INSERT INTO public."user" (id,email,name,password,"clusterGroupId","isAdmin","shouldChangePassword","storageLabel")
          SELECT id,$2,$3,$4,id,true,false,'admin' FROM bootstrap_group RETURNING id)
        INSERT INTO public.admin_audit_event ("userId","actorId",action,subject,detail)
        SELECT id,id,$5,$3,$6 FROM bootstrap_user`,
        [userId, email, name, passwordHash, AdminAuditAction.AccountCreated, detail],
      );
      return userId;
    });
  } catch (error) {
    if (error instanceof LibraryImportRefused) throw error;
    if (error instanceof ImportRefused) throw new LibraryImportRefused(error.code);
    throw new LibraryImportRefused('IMPORT_BOOTSTRAP_ADMIN_WRITE_FAILED');
  }
}
