import { describe, expect, it } from 'vitest';
import z from 'zod';
import { OwnerBackupHistoryDto, OwnerBackupRestoreDto } from 'src/dtos/cloud-backup-owner.dto.js';
import {
  CloudBackupManifestAlbumsDto,
  CloudBackupManifestItemsDto,
  CloudBackupRestoreDto,
} from 'src/dtos/cloud-backup.dto.js';
import { clientBackupContext, clientBackupManifestKey } from 'src/utils/cloud-backup-crypto.js';
import { manifestKey } from 'src/utils/cloud-backup.js';

const vault = '8bfb42bc-4df2-41da-bb1f-1a3354ea60a2';
const legacy = manifestKey(new Date('2026-10-11T03:00:00Z'));
const encrypted = clientBackupManifestKey(vault, 1, legacy);
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

  it.each([legacy, encrypted, clientBackupManifestKey(vault, 999_999_999, legacy)])('accepts written key %s', (key) => {
    for (const request of [...admin, ...owner]) {
      expect(request.schema.safeParse({ ...request.body, manifestKey: key }).success, request.name).toBe(true);
    }
  });

  it.each([
    `../${legacy}`,
    `${legacy}/../other`,
    `prefix/${legacy}`,
    `${legacy}?version=1`,
    encrypted.replace('/1/', '/0/'),
    encrypted.replace('/1/', '/1000000000/'),
    encrypted.replace('/v1/', '/v2/'),
    encrypted.replace(vault, 'invalid-vault'),
    encrypted.replace('m/', 'o/'),
    encrypted.replace('m/', 'db/'),
    encrypted.replace(legacy.slice(2), () => `../${legacy.slice(2)}`),
    encrypted.replace(legacy.slice(2), () => `%2e%2e/${legacy.slice(2)}`),
    `m/${'a'.repeat(301)}.json.gz`,
    '',
  ])('rejects invalid manifest key %s', (key) => {
    for (const request of [...admin, ...owner]) {
      expect(request.schema.safeParse({ ...request.body, manifestKey: key }).success, request.name).toBe(false);
    }
  });

  it('retains downstream format and vault binding', () => {
    expect(clientBackupContext('bucket', legacy, vault)).toBeNull();
    expect(clientBackupContext('bucket', encrypted, vault)).toMatchObject({
      kind: 'manifest',
      vaultId: vault,
      keyVersion: 1,
    });
    expect(() => clientBackupContext('bucket', encrypted, 'another-vault')).toThrow('Backup vault mismatch');
    expect(() => clientBackupContext('bucket', encrypted.replace('/v1/', '/v2/'), vault)).toThrow(
      'Unsupported client backup object format',
    );
  });
});
