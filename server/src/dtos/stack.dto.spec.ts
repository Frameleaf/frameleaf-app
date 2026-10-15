import { Stack } from 'src/database.js';
import { mapStack } from 'src/dtos/stack.dto.js';
import { AssetVisibility } from 'src/enum.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { getForAsset } from 'test/mappers.js';
import { newUuid } from 'test/small.factory.js';

it.each(['ordinary', 'elevated', 'shared', 'other-elevated', 'anonymous'] as const)(
  'preserves Locked member visibility for %s viewers',
  (mode) => {
    const owner = newUuid();
    const other = newUuid();
    const unlocked = getForAsset(AssetFactory.from({ ownerId: owner }).exif().build());
    const ownLocked = getForAsset(
      AssetFactory.from({ ownerId: owner, visibility: AssetVisibility.Locked }).exif().build(),
    );
    const otherLocked = getForAsset(
      AssetFactory.from({ ownerId: other, visibility: AssetVisibility.Locked }).exif().build(),
    );
    const auth = {
      ordinary: AuthFactory.from({ id: owner }).session().build(),
      elevated: AuthFactory.from({ id: owner }).session({ hasElevatedPermission: true }).build(),
      shared: AuthFactory.from({ id: owner }).session({ hasElevatedPermission: true }).sharedLink().build(),
      'other-elevated': AuthFactory.from({ id: other }).session({ hasElevatedPermission: true }).build(),
      anonymous: undefined,
    }[mode];
    const stack = { id: newUuid(), primaryAssetId: ownLocked.id, assets: [unlocked, otherLocked, ownLocked] } as Stack;
    const expected =
      mode === 'elevated'
        ? [ownLocked.id, unlocked.id]
        : mode === 'other-elevated'
          ? [unlocked.id, otherLocked.id]
          : [unlocked.id];
    expect(mapStack(stack, { auth }).assets.map(({ id }) => id)).toEqual(expected);
  },
);

it('preserves duplicate primary members and leaves the input array untouched', () => {
  const primary = getForAsset(AssetFactory.create());
  const secondary = getForAsset(AssetFactory.create());
  const members = [secondary, primary, primary];
  const stack = { id: newUuid(), primaryAssetId: primary.id, assets: members } as Stack;
  expect(mapStack(stack, {}).assets.map(({ id }) => id)).toEqual([primary.id, primary.id, secondary.id]);
  expect(stack.assets).toBe(members);
  expect(members).toEqual([secondary, primary, primary]);
});

it('skips sparse member slots as the original native filters do', () => {
  const primary = getForAsset(AssetFactory.create());
  const secondary = getForAsset(AssetFactory.create());
  const members: Stack['assets'] = [];
  members.length = 3;
  members[1] = secondary;
  members[2] = primary;
  const stack = { id: newUuid(), primaryAssetId: primary.id, assets: members } as Stack;
  expect(mapStack(stack, {}).assets.map(({ id }) => id)).toEqual([primary.id, secondary.id]);
  expect(0 in members).toBe(false);
});

it('does not read every visible member ID twice while partitioning primary members', () => {
  const members = Array.from({ length: 64 }, () => getForAsset(AssetFactory.create()));
  const primaryAssetId = members.at(-1)!.id;
  const expected = [primaryAssetId, ...members.slice(0, -1).map(({ id }) => id)];
  let reads = 0;
  for (const member of members) {
    const id = member.id;
    Object.defineProperty(member, 'id', {
      get: () => {
        reads++;
        return id;
      },
    });
  }
  const stack = { id: newUuid(), primaryAssetId, assets: members } as Stack;
  expect(mapStack(stack, {}).assets.map(({ id }) => id)).toEqual(expected);
  expect(reads).toBeLessThanOrEqual(members.length * 2);
});
