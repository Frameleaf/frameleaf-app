import type { SyncAck } from 'src/types.js';
import { SyncAssetV2, SyncItem } from 'src/dtos/sync.dto.js';
import { SyncEntityType } from 'src/enum.js';
import { hexOrBufferToBase64 } from 'src/utils/bytes.js';

type Impossible<K extends keyof any> = {
  [P in K]: never;
};

type Exact<T, U extends T = T> = U & Impossible<Exclude<keyof U, keyof T>>;

export const fromAck = (ack: string): SyncAck => {
  const [type, updateId, extraId] = ack.split('|', 3);
  return { type: type as SyncEntityType, updateId, extraId };
};

export const toAck = ({ type, updateId, extraId }: SyncAck) =>
  [type, updateId, extraId].filter((v) => v !== undefined).join('|');

export const mapJsonLine = (object: unknown) => JSON.stringify(object) + '\n';

export type SerializeOptions<T extends keyof SyncItem, D extends SyncItem[T]> = {
  type: T;
  data: Exact<SyncItem[T], D>;
  ids: [string] | [string, string];
  ackType?: SyncEntityType;
};

export const serialize = <T extends keyof SyncItem, D extends SyncItem[T]>({
  type,
  data,
  ids,
  ackType,
}: SerializeOptions<T, D>) =>
  mapJsonLine({ type, data, ack: toAck({ type: ackType ?? type, updateId: ids[0], extraId: ids[1] }) });

type AssetLike = Omit<SyncAssetV2, 'checksum' | 'thumbhash'> & {
  checksum: Buffer<ArrayBufferLike>;
  thumbhash: Buffer<ArrayBufferLike> | null;
};

export const mapSyncAssetV2 = ({ checksum, thumbhash, ...data }: AssetLike): SyncAssetV2 => ({
  ...data,
  checksum: hexOrBufferToBase64(checksum),
  thumbhash: thumbhash ? hexOrBufferToBase64(thumbhash) : null,
});

/**
 * A partner's Locked asset (FL-34) is still streamed, with visibility `locked`, so a device that
 * already holds it hides it; nothing that describes the picture goes with it.
 */
const withoutLockedDetails = <T extends AssetLike>(asset: T): T => ({
  ...asset,
  originalFileName: '',
  thumbhash: null,
  livePhotoVideoId: null,
});

export const mapPartnerAsset = ({ isLocked, ...asset }: AssetLike & { isLocked: boolean }) =>
  mapSyncAssetV2(isLocked ? withoutLockedDetails(asset) : asset);
