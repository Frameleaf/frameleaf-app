import * as semver from 'semver';
import supportedVersions from 'src/fork-schema/supported-versions.json' with { type: 'json' };

type ReleaseManifest = {
  ranges: readonly string[];
  certifiedTags: readonly string[];
  upstreamMigrations: readonly string[];
  reversionSupported: boolean;
};

export const SUPPORTED_UPSTREAM_MIGRATIONS: readonly string[] = supportedVersions.upstreamMigrations;

/**
 * Upstream-authored migrations the fork bundles and applies that landed AFTER
 * the certified official tag (exact tag v3.1.0 ships without them). They are
 * part of the fork's official-provider order, but a database that is byte-exact
 * certified official must NOT contain them: cutover reverts their effects and
 * removes their ledger rows, and the fork return re-applies them.
 */
export const POST_CERTIFIED_UPSTREAM_MIGRATIONS: ReadonlySet<string> = new Set(
  supportedVersions.postCertifiedUpstreamMigrations,
);

/** The exact ledger of the certified official tag (v3.1.0). */
export const CERTIFIED_TAG_MIGRATIONS: readonly string[] = SUPPORTED_UPSTREAM_MIGRATIONS.filter(
  (name) => !POST_CERTIFIED_UPSTREAM_MIGRATIONS.has(name),
);

export const LEGACY_FORK_MIGRATIONS: ReadonlySet<string> = new Set([
  '1778000000000-PhysicalDeduplication',
  '1778255964846-PhysicalDeduplicationSchemaReconcile',
  '1778300000000-AddVideoDuplicateFrames',
  '1778788656647-AddVideoDuplicateFrameTriggerOverride',
  '1778900000000-CreateAssetHealthTables',
  '1779000000000-AddAssetBestPhotoScore',
  '1779100000000-ReconcileAssetHealthAndBestPhotoSchema',
  '1779200000000-AddAssetExifDescriptionTrigramIndex',
  '1779300000000-AddSmartSearchDescriptionTable',
  '1779400000000-UpdateWorkflowTables',
  '1779500000000-ReconcileSchemaDrift',
  '1779600000000-CreateSmartAlbumTables',
  '1779700000000-AddAlbumParentAndClosure',
  '1779800000000-AddAlbumIcon',
  '1779900000000-AddAlbumSortOrder',
  '2100000000010-AddAssetIsNsfwIndex',
  '2100000000020-AddAlbumCycleGuardTrigger',
  '2100000000030-AddSha256ChecksumAlgorithm',
  '2100000000040-ReconcileSmartAlbumDrift',
  '2100000000050-AddMediaHealthRunOwner',
  '2100000000060-FixMediaHealthUpdatedAtTriggers',
  '2100000000070-ReconcileMediaHealthSchema',
  '2100000000080-AddAlbumKind',
  '2100000000090-AddPartnerShareLocation',
  '2100000000100-AddAssetFaceCorrectedAt',
  '2100000000110-AddMemoryExport',
  '2100000000130-AddAssetAudioChannelLayout',
  '2100000000140-CreateMlDestinations',
  '2100000000150-AddPetIdentities',
  '2100000000160-AddMediaOperationTables',
  '2100000000170-AddRenderWorkers',
  '2100000000180-AddStudioPreviewFrames',
  '2100000000190-AddSharedSpaceInvite',
  '2100000000200-AddSharedSpacePanels',
  '2100000000210-AddMediaOperationBulkResult',
  '2100000000220-AddStudioProjectTables',
  '2100000000240-AddAssetRestorationTable',
  '2100000000250-AddStudioProjectLifecycle',
  '2100000000260-AddSharedSpaceCollaboration',
  '2100000000270-AddMediaOperationAutoRetry',
  '2100000000280-AddSharedSpaceCommentThread',
  '2100000000290-ClearLockedAlbumCovers',
  '2100000000300-ClearLockedCoverReferences',
  '2100000000310-LockWholeStacksAndRecordProfileImageSource',
  '2100000000320-AddAssetLock',
  '2100000000340-AddMediaOperationPause',
  '2100000000380-AddVideoMomentIndex',
  '2100000000390-AddDuplicateDecision',
  '2100000000400-AddAssetDocumentEdit',
  '2100000000450-AddAdminAuditEvent',
  '2100000000460-AddTakeoutImport',
  '2100000000490-SeparateRestorationWorkers',
  '2100000000500-AddVideoMomentFrameVectorIndex',
  '2100000000510-AddPreservationPackages',
  '2100000000530-ReconcileFrameleafSchemaSnapshots',
  '2100000000540-AddPhotoToolsPresetsAndExports',
  '2100000000560-AddOperationalMetricSample',
  '2100000000570-AddWorkflowDefinitions',
  '2100000000580-AddStudioExportVersions',
  '2100000000590-HardenMediaOperationRetryAndCheckpoints',
  '2100000000610-AddClassificationRule',
  '2100000000620-FrameleafCloudMlDestination',
  '2100000000630-AddWorkflowRunStep',
  '2100000000640-AddAssetFilePathIndex',
]);

export const GENERIC_LEGACY_FORK_MIGRATIONS: ReadonlySet<string> = new Set(
  [...LEGACY_FORK_MIGRATIONS].filter((name) => name !== '1779400000000-UpdateWorkflowTables'),
);

export function classifyMigration(name: string): 'upstream' | 'legacy-fork' | 'unknown' {
  if (LEGACY_FORK_MIGRATIONS.has(name)) {
    return 'legacy-fork';
  }

  if (supportedVersions.upstreamMigrations.includes(name)) {
    return 'upstream';
  }

  return 'unknown';
}

export function assertSupportedUpstream(version: string): void {
  if (supportedVersions.ranges.every((range) => !semver.satisfies(version, range))) {
    throw new Error(`Unsupported official Immich database version: ${version}`);
  }
}

export function assertReleaseManifest(
  serverVersion: string,
  manifest: ReleaseManifest,
  bundledMigrations: readonly string[],
): void {
  if (manifest.ranges.every((range) => !semver.satisfies(serverVersion, range))) {
    throw new Error(`Server version ${serverVersion} is outside the reversion compatibility manifest`);
  }

  if (manifest.reversionSupported && manifest.certifiedTags.length === 0) {
    throw new Error('Reversion support requires at least one certified official tag');
  }

  if (
    manifest.upstreamMigrations.length !== bundledMigrations.length ||
    manifest.upstreamMigrations.some((name, index) => name !== bundledMigrations[index])
  ) {
    throw new Error('Bundled official migration provider does not match the official migration manifest');
  }
}
