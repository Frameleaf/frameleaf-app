import type { SyncAck } from 'src/types.js';
import { SyncAssetV2, SyncItem } from 'src/dtos/sync.dto.js';
import { AssetVisibility, SyncEntityType } from 'src/enum.js';
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

type AssetLike = Omit<SyncAssetV2, 'checksum' | 'thumbhash' | 'partnerOriginOwnerId'> & {
  checksum: Buffer<ArrayBufferLike>;
  thumbhash: Buffer<ArrayBufferLike> | null;
  partnerOriginOwnerId?: string | null;
};

/** Only a partner copy carries the field, so every other row stays byte for byte what older clients know. */
export const withPartnerOrigin = <T extends { partnerOriginOwnerId?: string | null }>({
  partnerOriginOwnerId,
  ...row
}: T) => ({ ...row, ...(partnerOriginOwnerId ? { partnerOriginOwnerId } : {}) });

export const mapSyncAssetV2 = ({ checksum, thumbhash, ...data }: AssetLike): SyncAssetV2 => ({
  ...withPartnerOrigin(data),
  checksum: hexOrBufferToBase64(checksum),
  thumbhash: thumbhash ? hexOrBufferToBase64(thumbhash) : null,
});

/**
 * FL-1767: the row a session that is not unlocked receives for one of its owner's own Locked items: only
 * that the item exists and is Locked now, so a device that already holds it drops it (the iPhone and
 * Android apps delete a `locked` row from their mirror). Its name, checksum, thumbhash, dates, size and
 * links are not sent. The hidden video half of a Locked live photo is reported `locked` too, so a device
 * drops it with its photo.
 */
const withheldLockedAsset = <T extends AssetLike>(asset: T): T => ({
  ...asset,
  originalFileName: '',
  thumbhash: null,
  checksum: Buffer.alloc(0),
  fileCreatedAt: null,
  fileModifiedAt: null,
  createdAt: null,
  localDateTime: null,
  duration: null,
  deletedAt: null,
  isFavorite: false,
  visibility: AssetVisibility.Locked,
  livePhotoVideoId: null,
  stackId: null,
  libraryId: null,
  width: null,
  height: null,
  isEdited: false,
  partnerOriginOwnerId: null,
});

/** An own (or album) asset row from the sync repository; `lockWithheld` comes from `syncLockWithheld`. */
export const mapOwnSyncAsset = ({ lockWithheld, ...asset }: AssetLike & { lockWithheld: boolean | null }) =>
  mapSyncAssetV2(lockWithheld ? withheldLockedAsset(asset) : asset);

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
