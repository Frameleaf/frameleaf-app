import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  assertReleaseManifest,
  assertSupportedUpstream,
  classifyMigration,
} from 'src/fork-schema/migration-manifest.js';
import {
  createCertifiedLedgerMigrationProvider,
  createOfficialMigrationProvider,
} from 'src/fork-schema/migration-provider.js';
import supportedVersions from 'src/fork-schema/supported-versions.json' with { type: 'json' };

const serverPackage = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string };

describe(classifyMigration, () => {
  it('classifies known legacy fork migrations', () => {
    expect(classifyMigration('1778000000000-PhysicalDeduplication')).toBe('legacy-fork');
    expect(classifyMigration('2100000000030-AddSha256ChecksumAlgorithm')).toBe('legacy-fork');
    expect(classifyMigration('2100000000040-ReconcileSmartAlbumDrift')).toBe('legacy-fork');
    expect(classifyMigration('2100000000070-ReconcileMediaHealthSchema')).toBe('legacy-fork');
    expect(classifyMigration('2100000000080-AddAlbumKind')).toBe('legacy-fork');
    expect(classifyMigration('2100000000090-AddPartnerShareLocation')).toBe('legacy-fork');
    expect(classifyMigration('2100000000100-AddAssetFaceCorrectedAt')).toBe('legacy-fork');
    expect(classifyMigration('2100000000110-AddMemoryExport')).toBe('legacy-fork');
    expect(classifyMigration('2100000000130-AddAssetAudioChannelLayout')).toBe('legacy-fork');
    expect(classifyMigration('2100000000140-CreateMlDestinations')).toBe('legacy-fork');
    expect(classifyMigration('2100000000150-AddPetIdentities')).toBe('legacy-fork');
    expect(classifyMigration('2100000000160-AddMediaOperationTables')).toBe('legacy-fork');
    expect(classifyMigration('2100000000170-AddRenderWorkers')).toBe('legacy-fork');
    expect(classifyMigration('2100000000180-AddStudioPreviewFrames')).toBe('legacy-fork');
    expect(classifyMigration('2100000000190-AddSharedSpaceInvite')).toBe('legacy-fork');
    expect(classifyMigration('2100000000200-AddSharedSpacePanels')).toBe('legacy-fork');
    expect(classifyMigration('2100000000210-AddMediaOperationBulkResult')).toBe('legacy-fork');
    expect(classifyMigration('2100000000220-AddStudioProjectTables')).toBe('legacy-fork');
    expect(classifyMigration('2100000000240-AddAssetRestorationTable')).toBe('legacy-fork');
    expect(classifyMigration('2100000000250-AddStudioProjectLifecycle')).toBe('legacy-fork');
    expect(classifyMigration('2100000000260-AddSharedSpaceCollaboration')).toBe('legacy-fork');
    expect(classifyMigration('2100000000270-AddMediaOperationAutoRetry')).toBe('legacy-fork');
    expect(classifyMigration('2100000000280-AddSharedSpaceCommentThread')).toBe('legacy-fork');
    expect(classifyMigration('2100000000290-ClearLockedAlbumCovers')).toBe('legacy-fork');
    expect(classifyMigration('2100000000300-ClearLockedCoverReferences')).toBe('legacy-fork');
    expect(classifyMigration('2100000000310-LockWholeStacksAndRecordProfileImageSource')).toBe('legacy-fork');
    expect(classifyMigration('2100000000320-AddAssetLock')).toBe('legacy-fork');
    expect(classifyMigration('2100000000340-AddMediaOperationPause')).toBe('legacy-fork');
    expect(classifyMigration('2100000000380-AddVideoMomentIndex')).toBe('legacy-fork');
    expect(classifyMigration('2100000000390-AddDuplicateDecision')).toBe('legacy-fork');
    expect(classifyMigration('2100000000400-AddAssetDocumentEdit')).toBe('legacy-fork');
    expect(classifyMigration('2100000000450-AddAdminAuditEvent')).toBe('legacy-fork');
    expect(classifyMigration('2100000000460-AddTakeoutImport')).toBe('legacy-fork');
    expect(classifyMigration('2100000000490-SeparateRestorationWorkers')).toBe('legacy-fork');
    expect(classifyMigration('2100000000500-AddVideoMomentFrameVectorIndex')).toBe('legacy-fork');
    expect(classifyMigration('2100000000510-AddPreservationPackages')).toBe('legacy-fork');
    expect(classifyMigration('2100000000530-ReconcileFrameleafSchemaSnapshots')).toBe('legacy-fork');
    expect(classifyMigration('2100000000540-AddPhotoToolsPresetsAndExports')).toBe('legacy-fork');
    expect(classifyMigration('2100000000560-AddOperationalMetricSample')).toBe('legacy-fork');
    expect(classifyMigration('2100000000570-AddWorkflowDefinitions')).toBe('legacy-fork');
    expect(classifyMigration('2100000000580-AddStudioExportVersions')).toBe('legacy-fork');
    expect(classifyMigration('2100000000590-HardenMediaOperationRetryAndCheckpoints')).toBe('legacy-fork');
    expect(classifyMigration('2100000000610-AddClassificationRule')).toBe('legacy-fork');
    expect(classifyMigration('2100000000620-FrameleafCloudMlDestination')).toBe('legacy-fork');
    expect(classifyMigration('2100000000630-AddWorkflowRunStep')).toBe('legacy-fork');
    expect(classifyMigration('2100000000640-AddAssetFilePathIndex')).toBe('legacy-fork');
    expect(classifyMigration('2100000000650-AddMlCloudModelChoice')).toBe('legacy-fork');
    expect(classifyMigration('2100000000660-HashSharedLinkPasswords')).toBe('legacy-fork');
  });

  it('classifies migrations from a certified upstream tag', () => {
    expect(classifyMigration('1744910873969-InitialMigration')).toBe('upstream');
  });

  it('does not guess unknown migrations', () => {
    expect(classifyMigration('9999999999999-CustomPatch')).toBe('unknown');
  });
});

it('accepts a supported upstream version', () => {
  expect(() => assertSupportedUpstream('3.0.3')).not.toThrow();
});

it('rejects an unsupported upstream version', () => {
  expect(() => assertSupportedUpstream('4.0.0')).toThrow();
});

describe(assertReleaseManifest, () => {
  it('pins the certified core plugin for every official image architecture', () => {
    expect(supportedVersions.certification.officialCorePluginDigests).toEqual({
      amd64: 'b6161c1e7535c6d18d90d78bd9851d7645da834e00c18521b662fa33beae8f07',
      arm64: '66369060c5d5aa41222fb148dfa397a5c316322ef2f01ff70a1725d7e0cb5d06',
    });
  });

  it('certifies the current server version and exact bundled official migration provider', async () => {
    const migrationFolder = resolve('src/schema/migrations');
    const bundledMigrations = Object.keys(
      await createCertifiedLedgerMigrationProvider(
        createOfficialMigrationProvider(migrationFolder),
        supportedVersions.upstreamMigrations,
      ).getMigrations(),
    );

    expect(() => assertReleaseManifest(serverPackage.version, supportedVersions, bundledMigrations)).not.toThrow();
  });

  it('rejects reversion support without a certified official tag', () => {
    expect(() =>
      assertReleaseManifest(
        serverPackage.version,
        { ...supportedVersions, certifiedTags: [], reversionSupported: true },
        supportedVersions.upstreamMigrations,
      ),
    ).toThrow('certified official tag');
  });

  it('rejects a release whose bundled official migrations drift from the manifest', () => {
    expect(() =>
      assertReleaseManifest(serverPackage.version, supportedVersions, supportedVersions.upstreamMigrations.slice(1)),
    ).toThrow('official migration manifest');
  });
});
