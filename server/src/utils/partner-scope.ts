import { sql } from 'kysely';
import { matchesChoice } from 'src/repositories/cloud-backup-selection.repository.js';
import { normalizeBackupFolder } from 'src/utils/cloud-backup-selection.js';

/** FL-774: a partnership's "Only what I choose". `null` means Everything. */
export type PartnerScopeChoice = {
  /** YYYY-MM-DD: only items taken on or after this day. */
  sinceDate: string | null;
  albumIds: string[];
  /** The API's person ids (`asset_face.personGroupId`). */
  personIds: string[];
  folders: string[];
};

/** Ids or folders one scope may name, per kind. */
export const PARTNER_SCOPE_MAX_ITEMS = 500;

const unique = <T>(values: T[]) => [...new Set(values)];

export const canonicalPartnerScope = (scope: PartnerScopeChoice): PartnerScopeChoice => ({
  sinceDate: scope.sinceDate,
  albumIds: unique(scope.albumIds.map((id) => id.toLowerCase())),
  personIds: unique(scope.personIds.map((id) => id.toLowerCase())),
  folders: unique(scope.folders.map((folder) => normalizeBackupFolder(folder)).filter(Boolean)),
});

export const partnerScopeChoosesAnything = (scope: PartnerScopeChoice) =>
  scope.sinceDate !== null || scope.albumIds.length > 0 || scope.personIds.length > 0 || scope.folders.length > 0;

/** A scope as the backup choice `matchesChoice` reads it, aliased `s`, from the table or from a draft. */
const SCOPE_COLUMNS = sql`'{}'::uuid[] AS "collectionIds", '{}'::uuid[] AS "tagIds", false AS favorites,
  '[]'::jsonb AS "dateRanges"`;

const storedScope = (sharedById: string, sharedWithId: string) => sql`(SELECT ps."sinceDate", ps."albumIds",
  ps."personIds", ps.folders, ${SCOPE_COLUMNS} FROM public.partner_scope ps
  WHERE ps."sharedById" = ${sharedById}::uuid AND ps."sharedWithId" = ${sharedWithId}::uuid)`;

/** Every scope of a partnership that still exists, with its pair, aliased by the caller. */
export const activeScopes = sql`(SELECT ps."sharedById", ps."sharedWithId", ps."sinceDate", ps."albumIds",
  ps."personIds", ps.folders, ${SCOPE_COLUMNS} FROM public.partner_scope ps
  JOIN public.partner p ON p."sharedById" = ps."sharedById" AND p."sharedWithId" = ps."sharedWithId")`;

export const draftScope = (scope: PartnerScopeChoice) => sql`(SELECT ${scope.sinceDate}::date AS "sinceDate",
  ${scope.albumIds}::uuid[] AS "albumIds", ${scope.personIds}::uuid[] AS "personIds",
  ${scope.folders}::text[] AS folders, ${SCOPE_COLUMNS})`;

/** Whether the asset `a` falls inside the scope `s`: taken since its date, and in any chosen album, person or folder. */
export const inScope = sql<boolean>`(
  (s."sinceDate" IS NULL OR (a."localDateTime" AT TIME ZONE 'UTC')::date >= s."sinceDate")
  AND (cardinality(s."albumIds") + cardinality(s."personIds") + cardinality(s.folders) = 0
    OR ${matchesChoice(sql<Date>`now()`)})
)`;

/** Whether the asset `a` goes to `sharedWithId` under `sharedById`'s scope (always, when they share Everything). */
export const partnerScopePredicate = (sharedById: string, sharedWithId: string) => sql<boolean>`(
  NOT EXISTS (SELECT 1 FROM public.partner_scope ps
    WHERE ps."sharedById" = ${sharedById}::uuid AND ps."sharedWithId" = ${sharedWithId}::uuid)
  OR EXISTS (SELECT 1 FROM ${storedScope(sharedById, sharedWithId)} s WHERE ${inScope})
)`;
