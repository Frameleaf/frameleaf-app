import { createHash } from 'node:crypto';
import { z } from 'zod';
import { resolveEnteComponents } from 'src/library-import/ente-files.js';
import fixture from 'src/library-import/fixtures/ente/0.4.2-media.json' with { type: 'json' };
import {
  type ImportManifest,
  importFilePathSchema,
  importFileSchema,
  importTimestampSchema,
  parseImportManifest,
} from 'src/library-import/manifest.js';
import { type SourceArchiveRecord, encodeSourceArchiveRecord } from 'src/library-import/source-archive-codec.js';

export const ENTE_EXPORT_SCHEMA_SHA256 = createHash('sha256')
  .update(
    JSON.stringify({
      format: 'ente-photos-export',
      version: 1,
      exporter: fixture.provenance.exporter,
      sourceCommit: fixture.provenance.sourceCommit,
      exporterBinarySha256: fixture.provenance.exporterBinarySha256,
    }),
  )
  .digest('hex');
const id = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine((value) => value.length < 19 || value <= '9223372036854775807');
const role = z.enum(['original', 'image', 'video']);
const utc = importTimestampSchema.refine((value) => value.endsWith('Z'));
const location = z.strictObject({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) });
const json = z.json().refine((value) => {
  let safe = true;
  JSON.stringify(value, (_key, field) => {
    if (typeof field === 'number' && Math.abs(field) > Number.MAX_SAFE_INTEGER) safe = false;
    return field;
  });
  return safe;
});
const document = z.record(z.string(), json);
const time = z.strictObject({ formatted: z.string(), timestamp: z.string().regex(/^-?\d+$/) });
const recordSchema = z.strictObject({
  title: z.string().min(1),
  creationTime: time,
  photoTakenTime: time,
  modificationTime: time.optional(),
  description: z.string().optional(),
  geoData: location,
  favorited: z.boolean(),
  ente: z.strictObject({
    fileID: id,
    type: z.enum(['image', 'video', 'livePhoto']),
    component: role,
    components: z.array(
      z.strictObject({ role, path: z.string(), size: z.number().int().safe().nonnegative(), hash: z.string() }),
    ),
    metadata: document,
    magicMetadata: document.optional(),
    pubMagicMetadata: document.optional(),
  }),
});
const albumSchema = z.strictObject({
  title: z.string(),
  ente: z.strictObject({
    albumID: id,
    ownerID: id,
    type: z.enum(['album', 'folder', 'favorites', 'uncategorized', 'defaultHidden']),
    magicMetadata: document.optional(),
    pubMagicMetadata: document.optional(),
    sharedMagicMetadata: document.optional(),
  }),
});
const inventorySchema = z.strictObject({
  id,
  ownerId: id,
  type: z.enum(['image', 'video', 'livephoto']),
  albumIds: z.array(id).min(1),
  caption: z.string().nullable(),
  createdAt: utc,
  dateTime: z.string().nullable(),
  offsetTime: z.string().nullable(),
  durationSeconds: z.number().nonnegative().nullable(),
  hash: z.string().nullable(),
  height: z.number().int().safe().nonnegative().nullable(),
  width: z.number().int().safe().nonnegative().nullable(),
  location: location.nullable(),
  modifiedAt: utc.nullable(),
  name: z.string().min(1),
  updatedAt: utc,
  visibility: z.string().nullable(),
});
const proofSchema = z.strictObject({
  path: z.string(),
  bytes: z.string(),
  sha256: z.string(),
  sourceHash: z.string(),
  modifiedAt: z.string(),
});
const accountSchema = z.strictObject({
  id,
  name: z.string(),
  directory: importFilePathSchema,
  root: z.strictObject({
    format: z.literal('ente-photos-export'),
    version: z.literal(1),
    userID: id,
    sourceVerifier: z.string().optional(),
  }),
  files: z.array(inventorySchema),
  albums: z.array(z.strictObject({ directory: importFilePathSchema, record: albumSchema })),
  placements: z.array(z.strictObject({ albumId: id, record: recordSchema, file: proofSchema })),
});
type File = z.infer<typeof inventorySchema>;
type Placement = z.infer<typeof accountSchema>['placements'][number];
type Account = z.infer<typeof accountSchema> & {
  fileIndex: Map<string, File>;
  albumIndex: Map<string, z.infer<typeof accountSchema>['albums'][number]>;
  seen: Map<string, Map<string, Map<string, Placement>>>;
  favourites: Map<string, boolean>;
};
const refuse = (code: string): never => {
  throw new Error('Ente source refused: ' + code);
};
const signature = ({
  ownerId,
  type,
  name,
  caption,
  createdAt,
  modifiedAt,
  dateTime,
  offsetTime,
  location,
  hash,
}: File) =>
  JSON.stringify({ ownerId, type, name, caption, createdAt, modifiedAt, dateTime, offsetTime, location, hash });

/** Converts verified decrypted export inventories; trusted capture and activation authority remain controller responsibilities. */
export function readEnteManifest(input: {
  source: ImportManifest['source'];
  inventory: ImportManifest['inventory'];
  accounts: unknown[];
}) {
  if (
    input.source.kind !== 'ente' ||
    input.source.version !== fixture.provenance.exporter ||
    input.source.schemaSha256 !== ENTE_EXPORT_SCHEMA_SHA256
  )
    return refuse('ENTE_CONTRACT_UNQUALIFIED');
  if (
    ['complete', 'ownershipComplete', 'privacyComplete', 'writersStopped'].some(
      (field) => Reflect.get(input.inventory, field) !== true,
    ) ||
    input.inventory.revisionBefore !== input.source.revision ||
    input.inventory.revisionAfter !== input.source.revision
  )
    return refuse('ENTE_CAPTURE_INCOMPLETE');
  const accounts = new Map<string, Account>(),
    directories = new Set<string>();
  for (const value of input.accounts) {
    const parsed = accountSchema.safeParse(value);
    if (!parsed.success) return refuse('ENTE_EXPORT_INVALID');
    const account = parsed.data;
    if (
      account.id !== account.root.userID ||
      accounts.has(account.id) ||
      directories
        .values()
        .some(
          (path) =>
            path === account.directory ||
            path.startsWith(account.directory + '/') ||
            account.directory.startsWith(path + '/'),
        )
    )
      return refuse('ENTE_ACCOUNT_BINDING_INVALID');
    directories.add(account.directory);
    const fileIndex = new Map(account.files.map((file) => [file.id, file]));
    const albumIndex = new Map(account.albums.map((album) => [album.record.ente.albumID, album]));
    if (
      fileIndex.size !== account.files.length ||
      albumIndex.size !== account.albums.length ||
      new Set(account.albums.map((album) => album.directory)).size !== account.albums.length
    )
      return refuse('ENTE_EXPORT_INCOMPLETE');
    if (
      account.placements.some(
        (placement) => !fileIndex.has(placement.record.ente.fileID) || !albumIndex.has(placement.albumId),
      )
    )
      return refuse('ENTE_EXPORT_INCOMPLETE');
    accounts.set(account.id, { ...account, fileIndex, albumIndex, seen: new Map(), favourites: new Map() });
  }
  if (accounts.size === 0) return refuse('ENTE_EXPORT_INCOMPLETE');
  const owners = new Map<
    string,
    { account: Account; file: File; components: Map<string, { proof: Placement['file']; name: string }> }
  >();
  const archive: SourceArchiveRecord[] = [];
  const losses: ImportManifest['losses'] = [{ code: 'ENTE_SOURCE_METADATA_ARCHIVED', acknowledged: false }];
  const loss = (code: string, entityId?: string) => {
    losses.push({ code, ...(entityId === undefined ? {} : { entityId }), acknowledged: false });
  };
  for (const account of accounts.values()) {
    archive.push({
      table: 'ente_account',
      value: { id: account.id, name: account.name, format: account.root.format, version: account.root.version },
    });
    for (const file of account.files) {
      const owner = accounts.get(file.ownerId),
        authoritative = owner?.fileIndex.get(file.id);
      if (!owner || !authoritative || authoritative.ownerId !== file.ownerId)
        return refuse('ENTE_OWNER_EXPORT_REQUIRED');
      if (signature(file) !== signature(authoritative)) return refuse('ENTE_METADATA_CONFLICT');
      if (!['visible', 'archived', 'hidden'].includes(authoritative.visibility ?? ''))
        return refuse('ENTE_VISIBILITY_REVIEW_REQUIRED');
      if (
        new Set(file.albumIds).size !== file.albumIds.length ||
        file.albumIds.some((id) => !account.albumIndex.has(id))
      )
        return refuse('ENTE_EXPORT_INCOMPLETE');
      if (!owners.has(file.id)) owners.set(file.id, { account: owner, file: authoritative, components: new Map() });
      archive.push({
        table: 'ente_file_inventory',
        value: { account_id: account.id, file_id: file.id, json: JSON.stringify(file) },
      });
    }
    for (const album of account.albums) {
      const ownerId = album.record.ente.ownerID;
      const authoritative = accounts.get(ownerId)?.albumIndex.get(album.record.ente.albumID);
      if (!authoritative || authoritative.record.ente.ownerID !== ownerId) return refuse('ENTE_OWNER_EXPORT_REQUIRED');
      const view =
        album.record.ente.ownerID === account.id
          ? album.record.ente.magicMetadata
          : album.record.ente.sharedMagicMetadata;
      if ((view?.visibility !== undefined && view.visibility !== 0) || album.record.ente.type === 'defaultHidden')
        loss('ENTE_ALBUM_VISIBILITY_ARCHIVED', account.id + ':' + album.record.ente.albumID);
      archive.push({
        table: 'ente_album',
        value: {
          account_id: account.id,
          album_id: album.record.ente.albumID,
          directory: album.directory,
          json: JSON.stringify(album.record),
        },
      });
    }
  }
  const paths = new Set<string>(),
    componentIdentities = new Map<string, string>();
  for (const account of accounts.values()) {
    for (const placement of account.placements) {
      const file = account.fileIndex.get(placement.record.ente.fileID),
        album = account.albumIndex.get(placement.albumId);
      if (!file || !album) return refuse('ENTE_EXPORT_INCOMPLETE');
      const resolved = resolveEnteComponents(placement.record, file, album.record);
      const current = resolved.find((component) => component.role === placement.record.ente.component)!;
      const proof = placement.file;
      if (
        proof.path !== account.directory + '/' + album.directory + '/' + current.path ||
        proof.bytes !== current.bytes ||
        proof.sourceHash !== current.sourceHash ||
        paths.has(proof.path) ||
        !importTimestampSchema.safeParse(proof.modifiedAt).success ||
        !importFileSchema.safeParse({
          id: 'proof',
          path: proof.path,
          bytes: proof.bytes,
          sha256: proof.sha256,
          role: 'original',
        }).success
      )
        return refuse('ENTE_FILE_EVIDENCE_MISMATCH');
      paths.add(proof.path);
      const sourceHash =
        file.type === 'livephoto'
          ? ['image', 'video']
              .map((role) => resolved.find((component) => component.role === role)!.sourceHash)
              .join(':')
          : current.sourceHash;
      if (file.hash !== null && file.hash !== sourceHash) return refuse('ENTE_FILE_EVIDENCE_MISMATCH');
      const componentId = file.id + ':' + current.role,
        identity = JSON.stringify([proof.bytes, proof.sha256, proof.sourceHash]);
      if (componentIdentities.has(componentId) && componentIdentities.get(componentId) !== identity)
        return refuse('ENTE_FILE_EVIDENCE_MISMATCH');
      componentIdentities.set(componentId, identity);
      const record = placement.record,
        seconds = String(Math.floor(Date.parse(file.createdAt) / 1000));
      if (
        record.title !== file.name ||
        (record.description ?? '') !== (file.caption ?? '') ||
        record.photoTakenTime.timestamp !== seconds ||
        record.creationTime.timestamp !== seconds ||
        record.geoData.latitude !== (file.location?.latitude ?? 0) ||
        record.geoData.longitude !== (file.location?.longitude ?? 0)
      )
        return refuse('ENTE_METADATA_CONFLICT');
      const micros =
        BigInt(seconds) * 1_000_000n + BigInt((/\.(\d+)(?=Z$)/.exec(file.createdAt)?.[1] ?? '').padEnd(6, '0'));
      const editedTime = record.ente.pubMagicMetadata?.editedTime;
      const declaredTime =
        typeof editedTime === 'number' && editedTime !== 0 ? editedTime : record.ente.metadata.creationTime;
      if (
        declaredTime !== undefined &&
        (typeof declaredTime !== 'number' || !Number.isSafeInteger(declaredTime) || BigInt(declaredTime) !== micros)
      )
        return refuse('ENTE_METADATA_CONFLICT');
      if (file.ownerId === account.id) {
        const visibility = record.ente.magicMetadata?.visibility ?? 0;
        if (typeof visibility !== 'number' || ![0, 1, 2].includes(visibility))
          return refuse('ENTE_VISIBILITY_REVIEW_REQUIRED');
        if (['visible', 'archived', 'hidden'][visibility] !== file.visibility) return refuse('ENTE_METADATA_CONFLICT');
      }
      const previousPreference = account.favourites.get(file.id);
      if (previousPreference !== undefined && previousPreference !== record.favorited)
        return refuse('ENTE_METADATA_CONFLICT');
      account.favourites.set(file.id, record.favorited);
      const memberships = account.seen.get(file.id) ?? new Map<string, Map<string, Placement>>();
      const roles = memberships.get(placement.albumId) ?? new Map<string, Placement>();
      if (roles.has(current.role)) return refuse('ENTE_EXPORT_INCOMPLETE');
      roles.set(current.role, placement);
      memberships.set(placement.albumId, roles);
      account.seen.set(file.id, memberships);
      if (file.ownerId === account.id) {
        const owner = owners.get(file.id)!;
        const selected = owner.components.get(current.role);
        if (!selected || proof.path < selected.proof.path)
          owner.components.set(current.role, { proof, name: current.path });
      }
      archive.push({
        table: 'frameleaf_ente_placement',
        value: {
          account_id: account.id,
          album_id: placement.albumId,
          file_id: file.id,
          component: current.role,
          path: proof.path,
          bytes: proof.bytes,
          sha256: proof.sha256,
          source_hash: proof.sourceHash,
          modified_at: proof.modifiedAt,
          json: JSON.stringify(record),
        },
      });
    }
    for (const file of account.files) {
      const memberships = account.seen.get(file.id);
      if (memberships?.size !== file.albumIds.length) return refuse('ENTE_EXPORT_INCOMPLETE');
      for (const albumId of file.albumIds) {
        const roles = memberships.get(albumId);
        const required = file.type === 'livephoto' ? ['image', 'video'] : ['original'];
        if (roles?.size !== required.length || required.some((role) => !roles.has(role)))
          return refuse('ENTE_EXPORT_INCOMPLETE');
      }
    }
  }
  const clock = (file: File) => {
    let offset = 0;
    if (file.offsetTime !== null) {
      const match = /^([+-])(\d{2}):(\d{2})$/.exec(file.offsetTime);
      if (!match || Number(match[2]) > 23 || Number(match[3]) > 59) return refuse('ENTE_CAPTURE_TIME_INVALID');
      offset = (Number(match[2]) * 60 + Number(match[3])) * (match[1] === '-' ? -1 : 1);
    } else loss('ENTE_CAPTURE_OFFSET_UNKNOWN', file.id);
    const fraction = /\.\d+(?=Z$)/.exec(file.createdAt)?.[0] ?? '';
    const date = new Date(Date.parse(file.createdAt) + offset * 60_000);
    if (!Number.isFinite(date.getTime())) return refuse('ENTE_CAPTURE_TIME_INVALID');
    let local = date.toISOString().slice(0, 19) + fraction;
    if (file.dateTime !== null) {
      const wall = file.dateTime.slice(0, 10).replaceAll(':', '-') + file.dateTime.slice(10).replace(' ', 'T');
      if (
        !importTimestampSchema.safeParse(wall + 'Z').success ||
        (file.offsetTime !== null && wall.slice(0, 19) !== local.slice(0, 19))
      )
        return refuse('ENTE_CAPTURE_TIME_INVALID');
      if (file.offsetTime === null) local = wall;
      else if (wall.includes('.') && wall.split('.', 2)[1].padEnd(6, '0') !== fraction.slice(1).padEnd(6, '0'))
        return refuse('ENTE_CAPTURE_TIME_INVALID');
    }
    return local;
  };
  const files: ImportManifest['files'] = [],
    assets: Extract<ImportManifest, { version: 5 }>['assets'] = [],
    livePhotos: Extract<ImportManifest, { version: 5 }>['livePhotos'] = [];
  for (const { account, file, components } of owners.values()) {
    const primaryRole = file.type === 'livephoto' ? 'image' : 'original',
      primary = components.get(primaryRole);
    if (!primary) return refuse('ENTE_EXPORT_INCOMPLETE');
    const favorite = account.favourites.get(file.id);
    if (favorite === undefined) return refuse('ENTE_EXPORT_INCOMPLETE');
    const nativeFavorite = file.albumIds.some((id) => account.albumIndex.get(id)!.record.ente.type === 'favorites');
    if (favorite !== nativeFavorite) return refuse('ENTE_METADATA_CONFLICT');
    const localDateTime = clock(file),
      primaryId = 'file:' + file.id + ':' + primaryRole;
    const add = (id: string, component: { proof: Placement['file']; name: string }) => {
      files.push({
        id,
        path: component.proof.path,
        bytes: component.proof.bytes,
        sha256: component.proof.sha256,
        role: 'original',
      });
    };
    add(primaryId, primary);
    if (primary.name !== file.name) loss('ENTE_ORIGINAL_NAME_ARCHIVED', file.id);
    const metadata = {
      takenAt: file.createdAt,
      description: file.caption ?? '',
      latitude: file.location?.latitude ?? null,
      longitude: file.location?.longitude ?? null,
      favorite,
    };
    assets.push({
      id: file.id,
      ownerId: file.ownerId,
      fileIds: [primaryId],
      primaryFileId: primaryId,
      type: file.type === 'video' ? 'VIDEO' : 'IMAGE',
      fileModifiedAt: primary.proof.modifiedAt,
      originalFileNames: { [primaryId]: primary.name },
      localDateTime,
      // Owner 2026-11-04: a hidden file imports Locked.
      visibility: file.visibility === 'archived' ? 'archive' : file.visibility === 'hidden' ? 'locked' : 'timeline',
      metadata,
    });
    if (file.type === 'livephoto') {
      const motion = components.get('video');
      if (!motion) return refuse('ENTE_EXPORT_INCOMPLETE');
      const motionId = 'motion:' + file.id,
        motionFileId = 'file:' + file.id + ':video';
      add(motionFileId, motion);
      assets.push({
        id: motionId,
        ownerId: file.ownerId,
        fileIds: [motionFileId],
        primaryFileId: motionFileId,
        type: 'VIDEO',
        visibility: 'hidden',
        fileModifiedAt: motion.proof.modifiedAt,
        originalFileNames: { [motionFileId]: motion.name },
        localDateTime,
        metadata: { takenAt: file.createdAt, latitude: metadata.latitude, longitude: metadata.longitude },
      });
      livePhotos.push({ photoAssetId: file.id, videoAssetId: motionId });
    }
  }
  const albums: ImportManifest['albums'] = [];
  for (const account of accounts.values()) {
    const memberships = new Map<string, string[]>();
    for (const file of account.files)
      if (file.ownerId === account.id)
        for (const albumId of file.albumIds) {
          const members = memberships.get(albumId) ?? [];
          members.push(file.id);
          memberships.set(albumId, members);
        }
    for (const [albumId, album] of account.albumIndex) {
      const members = memberships.get(albumId) ?? [];
      if (members.length === 0 && album.record.ente.ownerID !== account.id) continue;
      const dynamic = !['album', 'folder'].includes(album.record.ente.type);
      if (dynamic) loss('ENTE_DYNAMIC_ALBUM_SNAPSHOT', account.id + ':' + albumId);
      albums.push({
        id: 'album:' + albumId + ':owner:' + account.id,
        ownerId: account.id,
        name: album.record.title + (dynamic ? ' (snapshot)' : ''),
        assetIds: members,
        members: [],
      });
    }
  }
  if (
    accounts
      .values()
      .some(
        (account) =>
          account.files.some((file) => file.ownerId !== account.id) ||
          account.albums.some((album) => album.record.ente.ownerID !== account.id),
      )
  )
    loss('ENTE_SHARING_RESTRICTED');
  for (const record of archive) encodeSourceArchiveRecord(record);
  const manifest = parseImportManifest({
    format: 'frameleaf-library-import',
    version: 5,
    source: input.source,
    inventory: input.inventory,
    users: accounts
      .values()
      .map((account) => ({ id: account.id, name: account.name }))
      .toArray(),
    files,
    assets,
    albums,
    stacks: [],
    livePhotos,
    losses,
  });
  return { manifest, archive };
}
