import { createHash } from 'node:crypto';
import path from 'node:path';

export type ICloudRecord = {
  recordName: string;
  recordType?: string;
  recordChangeTag?: string;
  deleted?: boolean;
  fields: Record<string, unknown>;
};

type ResourceRole = 'original' | 'motion' | 'raw' | 'edited-image' | 'edited-video';
export type ICloudResource = {
  sourceAssetId: string;
  recordId: string;
  resourceKey: string;
  role: ResourceRole;
  fingerprint: string;
  expectedSize: number;
  source: Record<string, unknown>;
};

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const valueOf = (fields: Record<string, unknown>, key: string): unknown => {
  const field = fields[key];
  return object(field) ? field.value : undefined;
};
const boolOf = (value: unknown): boolean | undefined =>
  value === true || value === 1 ? true : value === false || value === 0 ? false : undefined;

const sensitiveKey = /url|token|expir|password|secret|credential|cookie|authorization|session|authattributes|scnt/i;
const sensitiveValue = /(?:https?:\/\/|data:|bearer\s)/i;

function sanitize(value: unknown): unknown {
  if (typeof value === 'string' && sensitiveValue.test(value)) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item)).filter((item) => item !== undefined);
  }
  if (object(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !sensitiveKey.test(key))
        .map(([key, item]) => [key, sanitize(item)])
        .filter(([, item]) => item !== undefined),
    );
  }
  return value;
}

/** Safe source metadata only; raw sessions never belong in inventory or manifests. */
export function sanitizeICloudFields(fields: Record<string, unknown>): Record<string, unknown> {
  return sanitize(fields) as Record<string, unknown>;
}

function canonicalDescriptor(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value
      .filter((item) => typeof item !== 'string' || !sensitiveValue.test(item))
      .map((item) => canonicalDescriptor(item))
      .join(',')}]`;
  }
  if (object(value)) {
    return `{${Object.keys(value)
      .filter((key) => !sensitiveKey.test(key) && (typeof value[key] !== 'string' || !sensitiveValue.test(value[key])))
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map((key) => `${JSON.stringify(key)}:${canonicalDescriptor(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Matches the Go bridge's recursively filtered, sorted encoding/json representation. */
export function resourceFingerprint(descriptor: Record<string, unknown>): string {
  const canonical = canonicalDescriptor(descriptor).replaceAll(
    /[<>&\u{2028}\u{2029}]/gu,
    (character) => String.raw`\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`,
  );
  return createHash('sha256').update(canonical).digest('hex');
}

function decodedName(field: unknown): string | undefined {
  if (!object(field) || typeof field.value !== 'string') {
    return;
  }
  if (field.type === 'STRING') {
    return field.value.normalize('NFC');
  }
  const encoded = field.value;
  if (!/^[\d+/A-Za-z]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
    return;
  }
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    return;
  }
  return decoded.toString('utf8').normalize('NFC');
}

function mediaType(uti: unknown): 'IMAGE' | 'VIDEO' | undefined {
  if (typeof uti !== 'string') {
    return;
  }
  if (/video|movie|mpeg|m4v|avi/.test(uti)) {
    return 'VIDEO';
  }
  if (/image|jpeg|png|heic|heif|tiff|gif|raw|avif|webp/.test(uti)) {
    return 'IMAGE';
  }
}

const utiExtensions: Record<string, string> = {
  'public.jpeg': '.jpg',
  'public.png': '.png',
  'public.heic': '.heic',
  'public.heif': '.heif',
  'public.tiff': '.tiff',
  'public.mpeg-4': '.mp4',
  'com.apple.quicktime-movie': '.mov',
  'com.adobe.raw-image': '.dng',
  'com.canon.cr2-raw-image': '.cr2',
  'com.canon.cr3-raw-image': '.cr3',
  'com.nikon.raw-image': '.nef',
  'com.sony.arw-raw-image': '.arw',
  'com.fuji.raw-image': '.raf',
  'com.panasonic.rw2-raw-image': '.rw2',
  'com.olympus.raw-image': '.orf',
  'com.pentax.raw-image': '.pef',
  'com.nikon.nrw-raw-image': '.nrw',
  'public.avif': '.avif',
  'org.webmproject.webp': '.webp',
};

function resourceName(name: string | undefined, role: ResourceRole, uti: unknown): string | undefined {
  if (name === undefined || role === 'original') {
    return name;
  }
  const ext = role === 'motion' ? '.MOV' : typeof uti === 'string' ? utiExtensions[uti] : undefined;
  if (!ext) {
    return;
  }
  const stem = name.slice(0, name.length - path.extname(name).length);
  if (role === 'edited-image' || role === 'edited-video') {
    return `${stem}-edited${ext}`;
  }
  return role === 'raw' && `${stem}${ext}`.toLowerCase() === name.toLowerCase() ? `${stem}-alt${ext}` : `${stem}${ext}`;
}

/** One source asset at a time. Caller persists and rejoins records across inventory pages. */
export function resourcesForICloudAsset(asset: ICloudRecord, master?: ICloudRecord): ICloudResource[] {
  if (
    !asset.recordName ||
    asset.recordType !== 'CPLAsset' ||
    asset.deleted ||
    boolOf(valueOf(asset.fields, 'isDeleted'))
  ) {
    return [];
  }
  const reference = valueOf(asset.fields, 'masterRef');
  const masterId = object(reference) && typeof reference.recordName === 'string' ? reference.recordName : undefined;
  if (master?.recordType !== 'CPLMaster' || master.recordName !== masterId || master.deleted) {
    master = undefined;
  }
  const resources: ICloudResource[] = [];
  const common: Record<string, unknown> = {
    sourceAssetId: asset.recordName,
    ...(masterId && { sourceMasterId: masterId }),
    ...(asset.recordChangeTag && { assetRecordChangeTag: asset.recordChangeTag }),
    ...(master?.recordChangeTag && { masterRecordChangeTag: master.recordChangeTag }),
    assetFields: sanitizeICloudFields(asset.fields),
    ...(master && { masterFields: sanitizeICloudFields(master.fields) }),
  };
  const name = decodedName(master?.fields.filenameEnc ?? asset.fields.filenameEnc);
  const date = valueOf(asset.fields, 'assetDate');
  if (typeof date === 'number' && Number.isFinite(date) && Math.abs(date) <= 8_640_000_000_000_000) {
    common.fileCreatedAt = new Date(date).toISOString();
  }
  for (const flag of ['isFavorite', 'isHidden']) {
    const value = boolOf(valueOf(asset.fields, flag));
    if (value !== undefined) {
      common[flag] = value;
    }
  }
  const add = (record: ICloudRecord | undefined, resourceKey: string, role: ResourceRole, type: unknown) => {
    if (!record) {
      return;
    }
    const descriptor = valueOf(record.fields, resourceKey);
    const expectedSize = object(descriptor) ? descriptor.size : undefined;
    if (
      !object(descriptor) ||
      typeof expectedSize !== 'number' ||
      !Number.isSafeInteger(expectedSize) ||
      expectedSize < 0
    ) {
      return;
    }
    const normalizedType =
      mediaType(type) ?? (role === 'edited-image' ? 'IMAGE' : role === 'edited-video' ? 'VIDEO' : undefined);
    const originalFileName = resourceName(name, role, type);
    resources.push({
      sourceAssetId: asset.recordName,
      recordId: record.recordName,
      resourceKey,
      role,
      fingerprint: resourceFingerprint(descriptor),
      expectedSize,
      source: {
        ...common,
        ...(originalFileName !== undefined && { originalFileName }),
        recordId: record.recordName,
        resourceKey,
        role,
        ...(normalizedType && { type: normalizedType }),
        resource: sanitizeICloudFields(descriptor),
      },
    });
  };
  if (master) {
    add(
      master,
      'resOriginalRes',
      'original',
      valueOf(master.fields, 'resOriginalFileType') ?? valueOf(master.fields, 'itemType'),
    );
    add(master, 'resOriginalVidComplRes', 'motion', 'public.movie');
    add(master, 'resOriginalAltRes', 'raw', valueOf(master.fields, 'resOriginalAltFileType'));
  }
  const adjustment = valueOf(asset.fields, 'adjustmentType');
  if (typeof adjustment === 'string' && adjustment !== '' && adjustment !== 'com.apple.video.slomo') {
    add(asset, 'resJPEGFullRes', 'edited-image', valueOf(asset.fields, 'resJPEGFullFileType'));
    add(asset, 'resVidFullRes', 'edited-video', valueOf(asset.fields, 'resVidFullFileType'));
  }
  return resources;
}

export function parseICloudAlbum(
  record: ICloudRecord,
):
  | { sourceId: string; parentSourceId: string | null; name: string; deleted: boolean; source: Record<string, unknown> }
  | undefined {
  if (
    !record.recordName ||
    ['----Root-Folder----', '----Project-Root-Folder----'].includes(record.recordName) ||
    (record.recordType !== undefined && !['CPLAlbum', 'CPLAlbumByPositionLive'].includes(record.recordType))
  ) {
    return;
  }
  const name = decodedName(record.fields.albumNameEnc);
  const deleted = record.deleted === true || boolOf(valueOf(record.fields, 'isDeleted')) === true;
  if (name === undefined && !deleted) {
    return;
  }
  const parent = valueOf(record.fields, 'parentId');
  return {
    sourceId: record.recordName,
    parentSourceId: typeof parent === 'string' && parent !== '' ? parent : null,
    name: name ?? '',
    deleted,
    source: {
      recordName: record.recordName,
      ...(record.recordChangeTag && { recordChangeTag: record.recordChangeTag }),
      isFolder: valueOf(record.fields, 'albumType') === 3,
      fields: sanitizeICloudFields(record.fields),
    },
  };
}
