import { createHash } from 'node:crypto';

/**
 * FL-296 (NAPI-014): iCloud source identity, shared by iCloud Photos Sync and the native app.
 *
 * `PHCloudIdentifier.stringValue` is documented as opaque. Observed values look like
 * `32A01DD9-75DF-41B2-8773-80C153D73A5A:001:AQohY6yKZR0+tXlMi9FUQ82zySGo`: very likely the CloudKit
 * CPLAsset record name, a version, and the CPLMaster record name (`0x01` and 20 bytes, base64). The
 * parsed parts are hints that need corroboration, never proof on their own (owner decision 7).
 */

export type ICloudIdentityRole = 'original' | 'live-motion' | 'raw-alternate' | 'edit-render';
export const ICLOUD_IDENTITY_ROLES: readonly ICloudIdentityRole[] = [
  'original',
  'live-motion',
  'raw-alternate',
  'edit-render',
];

/** The sync's resource roles, as identity roles. */
export const identityRoleOf: Record<string, ICloudIdentityRole> = {
  original: 'original',
  motion: 'live-motion',
  raw: 'raw-alternate',
  'edited-image': 'edit-render',
  'edited-video': 'edit-render',
};

export type MatchStrength = 'exact' | 'corroborated' | 'hint';

export type ParsedCloudIdentifier = { cplAssetRecordName: string; cplMasterRecordName: string | null };

const UUID = /^[\dA-F]{8}-[\dA-F]{4}-[\dA-F]{4}-[\dA-F]{4}-[\dA-F]{12}$/i;

/** The record names a `PHCloudIdentifier` string seems to carry, or null when it does not look like one. */
export const parseCloudIdentifier = (value: string): ParsedCloudIdentifier | null => {
  const parts = value.split(':');
  if (parts.length === 0 || parts.length > 3 || !UUID.test(parts[0])) {
    return null;
  }
  const master = parts.length === 3 ? parts[2] : '';
  return {
    cplAssetRecordName: parts[0].toUpperCase(),
    cplMasterRecordName: isAppleFingerprint(master) ? master : null,
  };
};

/** `0x01` and 20 bytes, base64 without padding: the form of a CPLMaster record name and a CloudKit `fileChecksum`. */
export const isAppleFingerprint = (value: string): boolean => {
  if (!/^[\d+/A-Za-z]{28}$/.test(value)) {
    return false;
  }
  const bytes = Buffer.from(value, 'base64');
  return bytes.length === 21 && bytes[0] === 0x01;
};

const APPLE_SALT = Buffer.from('com.apple.XattrObjectSalt\0com.apple.DataObjectSalt\0');

/**
 * Apple's fingerprint of a file's bytes, as CloudKit reports it in `fileChecksum` and (usually) as the
 * CPLMaster record name: `0x01 ‖ SHA-1(salt ‖ bytes)`, base64 without padding. Used only to
 * corroborate an identity, never as Frameleaf's integrity hash (SHA-256 stays authoritative).
 */
export const appleFingerprintHash = () => {
  const hash = createHash('sha1').update(APPLE_SALT);
  return {
    update: (chunk: Buffer) => hash.update(chunk),
    digest: () =>
      Buffer.concat([Buffer.from([0x01]), hash.digest()])
        .toString('base64')
        .replace(/=+$/, ''),
  };
};

export type IdentityEvidence = {
  /** The identity on record. */
  known: {
    cplAssetRecordName: string;
    cplMasterRecordName: string | null;
    appleFingerprint: string | null;
    sha256: Buffer;
  };
  /** What the device reported. */
  reported: ParsedCloudIdentifier & { sha256?: Buffer };
  /** Whether filename, UTI, pixel size and capture date agree with the Apple records. */
  metadataAgrees: boolean;
};

/**
 * How strongly a device's report matches an identity on record. `exact`: both record names match,
 * and the master name equals the server-computed Apple fingerprint, or the device sent the same
 * SHA-256 for that role. `corroborated`: the names match and the metadata agrees. `hint`: anything
 * weaker, reported but never acted on.
 */
export const matchStrength = ({ known, reported, metadataAgrees }: IdentityEvidence): MatchStrength => {
  const namesMatch =
    reported.cplAssetRecordName === known.cplAssetRecordName &&
    !!reported.cplMasterRecordName &&
    reported.cplMasterRecordName === known.cplMasterRecordName;
  if (!namesMatch) {
    return 'hint';
  }
  const fingerprintMatches = !!known.appleFingerprint && known.appleFingerprint === known.cplMasterRecordName;
  const hashMatches = !!reported.sha256 && reported.sha256.equals(known.sha256);
  if (fingerprintMatches || hashMatches) {
    return 'exact';
  }
  return metadataAgrees ? 'corroborated' : 'hint';
};

/** Only these count for ownership and the safety rings. */
export const isActionable = (strength: MatchStrength | null | undefined) =>
  strength === 'exact' || strength === 'corroborated';

/** `a•••@icloud.com`: enough for a person to recognise their account, nothing more. */
export const maskAppleAccount = (email: string): string => {
  const [local, domain] = email.split('@', 2);
  return domain ? `${local.slice(0, 1)}•••@${domain}` : '•••';
};

/** What PhotoKit tells the app about one item. */
export type ItemMetadata = {
  originalFilename?: string;
  uti?: string;
  pixelWidth?: number;
  pixelHeight?: number;
  creationDate?: string;
};

const fieldValue = (fields: Record<string, unknown> | null | undefined, key: string): unknown => {
  const field = fields?.[key];
  return typeof field === 'object' && field !== null && !Array.isArray(field)
    ? (field as { value?: unknown }).value
    : undefined;
};

/**
 * Whether a device's metadata agrees with the Apple records: the filename and capture date must be
 * given and agree; the type and pixel size must agree when both sides have them.
 */
export const metadataAgrees = (
  item: ItemMetadata,
  assetFields: Record<string, unknown>,
  masterFields: Record<string, unknown> | null,
  decodeName: (field: unknown) => string | undefined,
): boolean => {
  const name = decodeName(masterFields?.filenameEnc ?? assetFields.filenameEnc);
  const date = fieldValue(assetFields, 'assetDate');
  if (!item.originalFilename || !item.creationDate || !name || typeof date !== 'number') {
    return false;
  }
  if (name.toLowerCase() !== item.originalFilename.normalize('NFC').toLowerCase()) {
    return false;
  }
  if (Math.abs(Date.parse(item.creationDate) - date) > 1000) {
    return false;
  }
  const uti = fieldValue(masterFields, 'resOriginalFileType') ?? fieldValue(masterFields, 'itemType');
  if (item.uti && typeof uti === 'string' && uti !== item.uti) {
    return false;
  }
  const width = fieldValue(masterFields, 'resOriginalWidth');
  const height = fieldValue(masterFields, 'resOriginalHeight');
  if (item.pixelWidth && item.pixelHeight && typeof width === 'number' && typeof height === 'number') {
    const same = width === item.pixelWidth && height === item.pixelHeight;
    const turned = width === item.pixelHeight && height === item.pixelWidth;
    if (!same && !turned) {
      return false;
    }
  }
  return true;
};
