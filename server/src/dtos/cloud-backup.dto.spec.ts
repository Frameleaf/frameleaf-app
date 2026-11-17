import { describe, expect, it } from 'vitest';
import z from 'zod';
import { OwnerBackupHistoryDto, OwnerBackupRestoreDto } from 'src/dtos/cloud-backup-owner.dto.js';
import {
  CloudBackupManifestAlbumsDto,
  CloudBackupManifestItemsDto,
  CloudBackupRestoreDto,
} from 'src/dtos/cloud-backup.dto.js';

const vault = '8bfb42bc-4df2-41da-bb1f-1a3354ea60a2';
const admin = [
  { name: 'albums', schema: CloudBackupManifestAlbumsDto.schema, body: {} },
  { name: 'items', schema: CloudBackupManifestItemsDto.schema, body: {} },
  { name: 'restore', schema: CloudBackupRestoreDto.schema, body: { scope: 'files' } },
];
const owner = [
  { name: 'history/thumbnail', schema: OwnerBackupHistoryDto.schema, body: {} },
  {
    name: 'owner restore',
    schema: OwnerBackupRestoreDto.schema,
    body: { assetIds: ['00000000-0000-4000-8000-000000000001'] },
  },
];

describe('backup manifest request contracts', () => {
  it('retains the existing endpoint length contracts', () => {
    for (const request of admin) {
      expect(z.toJSONSchema(request.schema), request.name).not.toHaveProperty('properties.manifestKey.maxLength');
    }
    for (const request of owner) {
      const document = z.toJSONSchema(request.schema);
      const root = document.$ref ? document.$defs![document.$ref.slice('#/$defs/'.length)] : document;
      expect(root, request.name).toHaveProperty('properties.manifestKey.maxLength', 300);
    }
  });

  // FL-1676: a backup is named by its snapshot in the repository
  const snapshot = `r/v1/${vault}/s/000000000001-${'a'.repeat(16)}`;
  it.each([snapshot, `r/v1/${vault}/s/999999999999-${'f'.repeat(64)}`])('accepts a backup name %s', (key) => {
    for (const request of [...admin, ...owner]) {
      expect(request.schema.safeParse({ ...request.body, manifestKey: key }).success, request.name).toBe(true);
    }
  });

  it.each([
    `../${snapshot}`,
    `${snapshot}/../other`,
    `prefix/${snapshot}`,
    `${snapshot}?version=1`,
    snapshot.replace('/v1/', '/v2/'),
    snapshot.replace(vault, 'invalid-vault'),
    snapshot.replace('/s/', '/p/'),
    snapshot.replace('000000000001', '1'),
    `${snapshot.slice(0, -16)}${'a'.repeat(15)}`,
    `${snapshot.slice(0, -16)}${'A'.repeat(16)}`,
    'm/20261011T030000Z.json.gz',
    `m/v1/${vault}/1/20261011T030000Z.json.gz`,
    '',
  ])('rejects invalid manifest key %s', (key) => {
    for (const request of [...admin, ...owner]) {
      expect(request.schema.safeParse({ ...request.body, manifestKey: key }).success, request.name).toBe(false);
    }
  });
});
