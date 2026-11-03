import { type ReviewedImportContext } from 'src/library-import/reviewed-inputs.js';

// Synthetic protocol evidence; this fixture does not qualify any source.
export const context: ReviewedImportContext = {
  destinationId: 'aaaaaaaa-1111-4111-8111-111111111111',
  binding: {
    operationId: 'bbbbbbbb-2222-4222-8222-222222222222',
    manifestSha256: 'a'.repeat(64),
    planSha256: 'b'.repeat(64),
    source: {
      kind: 'photoprism',
      version: 'synthetic',
      identity: 'private source',
      revision: 'frozen',
      schemaSha256: 'c'.repeat(64),
    },
  },
};
export const at = '2026-11-03T07:00:00.000Z';
export const manager = { installation: '110100000001', operationId: context.binding.operationId };
export const report = () => {
  const common = {
    version: 1,
    operationId: context.binding.operationId,
    manifestSha256: context.binding.manifestSha256,
    planSha256: context.binding.planSha256,
  };
  return {
    ...common,
    format: 'frameleaf-library-import-verification',
    owners: {
      ...common,
      format: 'frameleaf-owner-reconciliation',
      owners: 2,
      preservedPasswords: 1,
      claimPending: 1,
      sha256: 'd'.repeat(64),
    },
    assets: {
      ...common,
      version: 2,
      format: 'frameleaf-asset-reconciliation',
      assets: 3,
      originals: 4,
      tagNodes: 1,
      tagAssignments: 2,
      bytes: '123',
      sha256: 'e'.repeat(64),
    },
    albums: {
      ...common,
      format: 'frameleaf-album-reconciliation',
      albums: 1,
      memberships: 3,
      grants: 1,
      sha256: 'f'.repeat(64),
    },
    stacks: { ...common, format: 'frameleaf-stack-reconciliation', stacks: 1, memberships: 2, sha256: '0'.repeat(64) },
    archive: {
      format: 'frameleaf-source-archive-verification',
      version: 1,
      operationId: common.operationId,
      records: '10',
      bytes: '200',
      sha256: '1'.repeat(64),
      sealed: true,
    },
  };
};
