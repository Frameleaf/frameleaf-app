import { AlbumUserRole, SharedLinkType } from 'src/enum.js';
import { AlbumUserFactory } from 'test/factories/album-user.factory.js';
import { AlbumFactory } from 'test/factories/album.factory.js';
import { AssetEditFactory } from 'test/factories/asset-edit.factory.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { SharedLinkFactory } from 'test/factories/shared-link.factory.js';
import { StackFactory } from 'test/factories/stack.factory.js';

it('keeps a replaced shared-link owner and its foreign key consistent', () => {
  const id = '74fdc18d-759c-4b7d-af89-eeb4e0054363';
  const link = SharedLinkFactory.from().owner({ id }).build();
  expect(link.owner.id).toBe(id);
  expect(link.userId).toBe(id);
});

it('keeps a selected shared album and its foreign key consistent', () => {
  const id = '74fdc18d-759c-4b7d-af89-eeb4e0054363';
  const link = SharedLinkFactory.from().album({ id }).build();
  expect(link.album?.id).toBe(id);
  expect(link.albumId).toBe(id);
  expect(link.type).toBe(SharedLinkType.Album);
});

it('preserves an explicitly supplied stack primary asset ID', () => {
  const id = '74fdc18d-759c-4b7d-af89-eeb4e0054363';
  const stack = StackFactory.create({ primaryAssetId: id });
  expect(stack.primaryAssetId).toBe(id);
  expect(stack.primaryAsset.id).toBe(id);
});

it('keeps generated relationships stable across repeated builds', () => {
  const factory = SharedLinkFactory.from().album();
  expect(factory.build()).toEqual(factory.build());
  const stack = StackFactory.from();
  expect(stack.build()).toEqual(stack.build());
});

it('replaces the default album owner without dropping other members', () => {
  const ownerId = '74fdc18d-759c-4b7d-af89-eeb4e0054363';
  const viewerId = '56a26ae7-f177-4248-90bd-822197bc54a4';
  const album = AlbumFactory.from()
    .albumUser({ userId: viewerId, role: AlbumUserRole.Viewer })
    .owner({ id: ownerId })
    .build();
  expect(
    album.albumUsers.filter((member) => member.role === AlbumUserRole.Owner).map((member) => member.userId),
  ).toEqual([ownerId]);
  expect(album.albumUsers.find((member) => member.userId === viewerId)?.role).toBe(AlbumUserRole.Viewer);
});

it('binds default album memberships to their parent album', () => {
  const album = AlbumFactory.from().albumUser().build();
  expect(album.albumUsers.every((member) => member.albumId === album.id)).toBe(true);
});

it('promotes an existing member without duplicating its membership', () => {
  const ownerId = '74fdc18d-759c-4b7d-af89-eeb4e0054363';
  const album = AlbumFactory.from().albumUser({ userId: ownerId }).owner({ id: ownerId }).build();
  expect(album.albumUsers).toHaveLength(1);
  expect(album.albumUsers[0]).toMatchObject({ userId: ownerId, role: AlbumUserRole.Owner });
});

it('uses existing related IDs without changing other fixture fields', () => {
  const id = '74fdc18d-759c-4b7d-af89-eeb4e0054363';
  expect(AlbumUserFactory.from().album({ id, albumName: 'Existing album' }).build().albumId).toBe(id);
  const edit = AssetEditFactory.from().asset({ id }).build();
  expect(edit.assetId).toBe(id);
  expect(edit.parameters).toEqual({ x: 5, y: 6, width: 200, height: 100 });
});

it('honors custom related builders even when an ID was supplied', () => {
  const original = '74fdc18d-759c-4b7d-af89-eeb4e0054363';
  const replacement = '56a26ae7-f177-4248-90bd-822197bc54a4';
  const member = AlbumUserFactory.from()
    .album({ id: original }, () => AlbumFactory.from({ id: replacement }))
    .build();
  const edit = AssetEditFactory.from()
    .asset({ id: original }, () => AssetFactory.from({ id: replacement }))
    .build();
  expect(member.albumId).toBe(replacement);
  expect(edit.assetId).toBe(replacement);
});
