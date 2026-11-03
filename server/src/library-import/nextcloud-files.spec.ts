import content from 'src/library-import/fixtures/nextcloud/35-8-10.2-content.json' with { type: 'json' };
import { resolveNextcloudHomeOriginal } from 'src/library-import/nextcloud-files.js';

const integers = (row: object) =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, typeof value === 'number' ? BigInt(value) : value]),
  );
const fixture = (fileId = '95') => {
  const file = content.rows.oc_filecache.find((row) => String(row.fileid) === fileId)!;
  const storage = content.rows.oc_storages.find((row) => row.numeric_id === file.storage)!;
  const mount = content.rows.oc_mounts.find((row) => row.storage_id === file.storage)!;
  return {
    file: integers(file),
    storage: integers(storage),
    mount: integers(mount),
    root: integers(content.rows.oc_filecache.find((row) => row.fileid === mount.root_id)!),
    owner: { ...content.rows.oc_users.find((row) => row.uid === mount.user_id)! },
    mimetype: integers(content.rows.oc_mimetypes.find((row) => row.id === file.mimetype)!),
  };
};

it('reconciles local home originals against the independent native storage API identities', () => {
  for (const expected of content.native.files) {
    expect(resolveNextcloudHomeOriginal(fixture(expected.id))).toEqual({
      fileId: expected.id,
      ownerId: expected.owner,
      storageId: expected.storageId,
      storageKey: String(fixture(expected.id).file.storage),
      path: expected.internalPath,
      bytes: expected.bytes,
      mime: expected.mime,
      role: 'original',
    });
  }
});

it('keeps duplicate bytes in distinct owner/storage scopes and never trusts path hashes or etags as content checksums', () => {
  const alice = resolveNextcloudHomeOriginal(fixture('95'));
  const bob = resolveNextcloudHomeOriginal(fixture('100'));
  expect(alice.ownerId).not.toBe(bob.ownerId);
  expect(alice.storageKey).not.toBe(bob.storageKey);
  expect(alice).not.toHaveProperty('sha256');
  expect(alice).not.toHaveProperty('etag');
});

it.each([
  '../outside.jpg',
  '/absolute.jpg',
  'files/../outside.jpg',
  'files//photo.jpg',
  String.raw`files/Photos\photo.jpg`,
  'files_trashbin/files/photo.jpg',
  'appdata/previews/photo.jpg',
  'files/Photos/\0photo.jpg',
])('refuses unsafe or non-original paths: %j', (path) => {
  const source = fixture();
  source.file.path = path;
  expect(() => resolveNextcloudHomeOriginal(source)).toThrow('NEXTCLOUD_ORIGINAL_INVALID');
});

it.each(['storage', 'mount', 'root', 'owner', 'mimetype'])('refuses mismatched %s identity', (key) => {
  const source = fixture();
  const record = source[key as keyof typeof source] as Record<string, unknown>;
  const field = ({ storage: 'numeric_id', mount: 'storage_id', root: 'fileid', owner: 'uid', mimetype: 'id' } as const)[
    key as 'storage'
  ];
  record[field] = typeof record[field] === 'bigint' ? 999_999n : 'another-owner';
  expect(() => resolveNextcloudHomeOriginal(source)).toThrow('NEXTCLOUD_ORIGINAL_INVALID');
});

it.each([
  ['file', 'encrypted', 1n],
  ['file', 'size', -1n],
  ['file', 'permissions', 0n],
  ['storage', 'id', 's3::bucket'],
  ['storage', 'available', 0n],
  ['mount', 'mount_provider_class', String.raw`OC\Files\Mount\ObjectHomeMountProvider`],
  ['mount', 'mount_id', 123n],
  ['root', 'path', 'files/elsewhere'],
  ['mimetype', 'mimetype', 'httpd/unix-directory'],
])('refuses unqualified %s.%s=%s', (key, field, value) => {
  const source = fixture();
  (source[key as keyof typeof source] as Record<string, unknown>)[field] = value;
  expect(() => resolveNextcloudHomeOriginal(source)).toThrow('NEXTCLOUD_ORIGINAL_INVALID');
});

it('retains database identities beyond JavaScript safe integers', () => {
  const source = fixture();
  source.file.fileid = 9_007_199_254_740_993n;
  expect(resolveNextcloudHomeOriginal(source).fileId).toBe('9007199254740993');
});
