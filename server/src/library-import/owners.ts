import { z } from 'zod';
import { ImportDatabase } from 'src/immich-import/types.js';
import { ImportedPassword } from 'src/library-import/passwords.js';

export const importedOwnerSchema = z.strictObject({
  operationId: z.uuid().transform((value) => value.toLowerCase()),
  sourceUserId: z.string().min(1).max(1024),
  destinationUserId: z.uuid().transform((value) => value.toLowerCase()),
  email: z
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
  name: z.string().max(1024),
});

/** Call inside the import journal's owner write after qualifying source login restrictions and permissions. */
export async function createImportedOwner(
  db: ImportDatabase,
  input: unknown,
  credential?: ImportedPassword,
  restrictLogin = false,
): Promise<void> {
  const parsed = importedOwnerSchema.safeParse(input);
  if (!parsed.success) throw new Error('Library import refused: OWNER_INVALID');
  const owner = parsed.data;
  if (
    credential &&
    (!(credential instanceof ImportedPassword) ||
      credential.operationId !== owner.operationId ||
      credential.sourceUserId !== owner.sourceUserId ||
      credential.destinationUserId !== owner.destinationUserId)
  )
    throw new Error('Library import refused: OWNER_CREDENTIAL_MISMATCH');
  let rows: Record<string, unknown>[];
  try {
    rows = await db.query(
      `WITH owner_group AS (
      INSERT INTO public.cluster_group (id)
      SELECT $1::uuid WHERE EXISTS (SELECT 1 FROM public."user"
        WHERE "isAdmin" AND status='active' AND "deletedAt" IS NULL AND NOT "importClaimPending")
      RETURNING id)
      INSERT INTO public."user" (id,email,name,"clusterGroupId",password,"importClaimPending","shouldChangePassword")
      SELECT $1::uuid,$2,$3,id,$4,$5,$6 FROM owner_group RETURNING id`,
      [
        owner.destinationUserId,
        owner.email,
        owner.name,
        credential?.forImport() ?? null,
        restrictLogin || !credential,
        !credential,
      ],
    );
  } catch {
    // Driver errors may contain a credential-bearing query or parameters.
    throw new Error('Library import refused: OWNER_WRITE_FAILED');
  }
  if (rows.length !== 1 || rows[0].id !== owner.destinationUserId)
    throw new Error('Library import refused: DESTINATION_ADMIN_REQUIRED');
}
