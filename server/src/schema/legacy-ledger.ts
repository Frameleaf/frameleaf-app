import { Kysely, sql } from 'kysely';

// Issue 863: 1.2.3 folded every earlier migration into the baseline, so a 1.2.2 ledger names files that no longer
// exist and the migrator refuses to start. The 1.2.2 chain plus the two migrations below builds the same schema as the
// baseline (catalogs differ only in how PostgreSQL prints ARRAY casts), so such a ledger is adopted as the baseline.
/** Every migration name recorded before 1.2.3, in order. 1.2.2 shipped all but the last two. */
export const LEGACY_CHAIN = [
  '0000000000000-FrameleafBaseline',
  '1791100800000-BoundedQueueQueries',
  '1791100900000-RestoreRegisteredMetadataTables',
  '1791101000000-IsolateSelectionCapture',
  '1791101100000-BoundedQueueRetention',
  '1791101300000-SelectionOutcomeHeaders',
  '1791101500000-RetainSelectionLineage',
  '1791101600000-LibraryScanSources',
  '1791101770000-AlbumSourceMembershipGeneration',
  '1791101770001-ICloudClaimAccessPaths',
  '1791101770002-JobCancellationReason',
  '1791101770003-StudioCreationIdempotency',
  '1791101770004-TimelineOrderedAccessPaths',
  '1791361500000-ImageEncodingInfo',
  '1791364000000-ImageRenditionIdentity',
  '1791368400000-HdrDevelopRenditions',
  '2100000002961-ICloudEditAuthority',
  '2100000002962-AssetLocalEffectAuthority',
  '2100000002963-StudioSubtitleSidecarArtifacts',
  '2100000002964-DevelopSourceAsset',
  '2100000002965-PushRenderOperation',
  '2100000002966-StudioImportPublication',
  '2100000002967-LandmarkPlaces',
  '2100000002968-FrameleafLockReason',
  '2100000002969-MeasuredGpuWorkingBudget',
  '2100000002970-ShareDevelopArtifactPaths',
  '2100000002990-CloudBackupSelection',
  '2100000002991-DesktopDevice',
  '2100000002992-DesktopMlBroker',
  '2100000002993-DesktopWorkerSession',
  '2100000002994-DesktopWorkerChallenge',
  '2100000002995-DesktopWorkerQualification',
  '2100000002996-MlRouteOrigin',
  '2100000002997-ClipProducerIdentity',
  '2100000002998-AllClipProducerIdentity',
  '2100000002999-DesktopClipIndex',
  '2100000003000-DesktopWorkerPresence',
  '2100000003001-DesktopMlDisclosure',
  '2100000003002-PhotoSources',
  '2100000003003-GeodataRuntimeCatalog',
  '2100000003004-ReadOnlyExternalLibraries',
  '2100000003005-SourceResourceGrants',
  '2100000003006-SourceResourceReads',
  '2100000003007-AssetLibraryPath',
  '2100000003008-MlProcessingOrder',
  '2100000003009-IdenticalFileChange',
  '2100000003010-SmartAlbumHidden',
  '2100000003011-UserUploadsPausedPasswordLink',
  '2100000003012-WorkflowBatches',
  '2100000003013-DevelopBatches',
  '2100000003021-LibraryScope',
  '2100000003022-BookmarksAndSources',
  '2100000003023-CaptureReceipts',
  '2100000003024-AssetPalettes',
  '2100000003025-ClassificationSearchFilter',
  '2100000003026-BookmarkRatings',
  '2100000003027-AlbumColor',
  '2100000003028-SpeechIndex',
  '2100000003029-BrowserExtensionSignIn',
  '2100000003030-AssetSourceImportedFrom',
  '2100000003031-AssetAnnotations',
  '2100000003032-EagleServerImport',
  '2100000003033-VideoTimelineFingerprint',
  '2100000003034-PhotoLocations',
  '2100000003035-PhotoLocationBilling',
  '2100000003036-LockedEncryption',
  '2100000003037-LandmarkInference',
  '2100000003038-TimelineCalendarPages',
  '2100000003039-AlbumSuggestions',
  '2100000003040-Sha256SyncChecksums',
  '2100000003041-AssetFaceOutfit',
  '2100000003042-ImportAccountClaims',
  '2100000003043-LibraryImportJournal',
  '2100000003044-AssetAdditionalOriginals',
  '2100000003045-LibraryImportReviewedInputs',
  '2100000003046-LibraryImportPrivateOwners',
  '2100000003047-LibraryImportSourceArchive',
  '2100000003048-LibraryImportActivation',
  '2100000003049-ImportedOwnerProvenance',
] as const;

const RELEASE_1_2_2_LENGTH = 77;

/** Migrations merged after 1.2.2 and before the reset; a 1.2.2 database still needs them. Bodies as they shipped. */
const LEGACY_TAIL: Record<string, (db: Kysely<any>) => Promise<unknown>> = {
  '2100000003048-LibraryImportActivation': (db) =>
    sql`ALTER TABLE public.frameleaf_library_import
    ADD COLUMN activation jsonb,
    ADD COLUMN activation_sha256 text,
    ADD CONSTRAINT frameleaf_library_import_activation_pair CHECK ((activation IS NULL) = (activation_sha256 IS NULL)),
    ADD CONSTRAINT frameleaf_library_import_activation_object CHECK (activation IS NULL OR jsonb_typeof(activation)='object'),
    ADD CONSTRAINT frameleaf_library_import_activation_hash CHECK (activation_sha256 IS NULL OR activation_sha256 ~ '^[a-f0-9]{64}$'),
    ADD CONSTRAINT frameleaf_library_import_activation_phase CHECK (activation IS NULL OR status='activated')`.execute(
      db,
    ),
  '2100000003049-ImportedOwnerProvenance': (db) =>
    sql`ALTER TABLE public."user" ADD COLUMN "importOperationId" uuid;
    WITH evidence AS (
      SELECT operation_id,destination_id FROM public.frameleaf_library_import_mapping WHERE entity_kind='owner'
      UNION
      SELECT i.operation_id,(owner->>'destinationId')::uuid FROM public.frameleaf_library_import i,
        LATERAL jsonb_array_elements(coalesce(i.reviewed_plan->'owners','[]'::jsonb)) owner
    ) UPDATE public."user" u SET "importOperationId"=e.operation_id FROM evidence e WHERE u.id=e.destination_id`.execute(
      db,
    ),
};

/** Rewrites a pre-1.2.3 ledger to the baseline alone. Leaves fresh and already-adopted databases untouched. */
export async function adoptLegacyLedger(db: Kysely<any>): Promise<string[]> {
  const { rows: ledger } = await sql<{ present: boolean }>`
    SELECT to_regclass('public.frameleaf_migrations') IS NOT NULL AS present`.execute(db);
  if (!ledger[0]?.present) return [];
  return db.transaction().execute(async (tx) => {
    await sql`LOCK TABLE public.frameleaf_migrations IN ACCESS EXCLUSIVE MODE`.execute(tx);
    const { rows } = await sql<{ name: string }>`SELECT name FROM public.frameleaf_migrations ORDER BY name`.execute(
      tx,
    );
    const names = rows.map(({ name }) => name);
    if (!names.includes(LEGACY_CHAIN[1])) return [];
    if (names.length < RELEASE_1_2_2_LENGTH || names.some((name, index) => name !== LEGACY_CHAIN[index])) {
      throw new Error(
        'This database was created by a Frameleaf release older than 1.2.2. Update to 1.2.2 first, then to this release.',
      );
    }
    const applied = LEGACY_CHAIN.slice(names.length);
    for (const name of applied) await LEGACY_TAIL[name](tx);
    await sql`DELETE FROM public.frameleaf_migrations WHERE name <> ${LEGACY_CHAIN[0]}`.execute(tx);
    return applied;
  });
}
