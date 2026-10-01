import {
  appleFingerprintHash,
  isActionable,
  isAppleFingerprint,
  maskAppleAccount,
  matchStrength,
  metadataAgrees,
  parseCloudIdentifier,
} from 'src/utils/icloud-identity.js';
import { decodedName } from 'src/utils/icloud-records.js';

const MASTER = 'AQohY6yKZR0+tXlMi9FUQ82zySGo';
const ASSET = '32A01DD9-75DF-41B2-8773-80C153D73A5A';

describe('iCloud source identity (FL-296)', () => {
  it('reads the record names a PHCloudIdentifier seems to carry, as hints', () => {
    expect(parseCloudIdentifier(`${ASSET}:001:${MASTER}`)).toEqual({
      cplAssetRecordName: ASSET,
      cplMasterRecordName: MASTER,
    });
    expect(parseCloudIdentifier(`${ASSET.toLowerCase()}:001:${MASTER}`)?.cplAssetRecordName).toBe(ASSET);
    // a master part that is not 0x01 and 20 bytes is no master name
    expect(parseCloudIdentifier(`${ASSET}:001:AAAA`)).toEqual({ cplAssetRecordName: ASSET, cplMasterRecordName: null });
    expect(parseCloudIdentifier(ASSET)).toEqual({ cplAssetRecordName: ASSET, cplMasterRecordName: null });
    expect(parseCloudIdentifier('not-an-identifier')).toBeNull();
    expect(parseCloudIdentifier(`${ASSET}:1:2:3`)).toBeNull();
  });

  it("computes Apple's fingerprint: 0x01 and the salted SHA-1, base64 without padding", () => {
    const hash = appleFingerprintHash();
    hash.update(Buffer.from('hel'));
    hash.update(Buffer.from('lo'));
    const value = hash.digest();
    expect(value).toBe('AcW96XzA8CMFcrVWfJyAAy8aWWE6');
    expect(isAppleFingerprint(value)).toBe(true);
    expect(isAppleFingerprint(MASTER)).toBe(true);
    expect(isAppleFingerprint('AgW96XzA8CMFcrVWfJyAAy8aWWE6')).toBe(false);
  });

  it('is exact only with proven bytes, corroborated with agreeing metadata, otherwise a hint', () => {
    const sha256 = Buffer.alloc(32, 7);
    const known = { cplAssetRecordName: ASSET, cplMasterRecordName: MASTER, appleFingerprint: null, sha256 };
    const reported = { cplAssetRecordName: ASSET, cplMasterRecordName: MASTER };

    expect(matchStrength({ known, reported: { ...reported, sha256 }, metadataAgrees: false })).toBe('exact');
    expect(matchStrength({ known: { ...known, appleFingerprint: MASTER }, reported, metadataAgrees: false })).toBe(
      'exact',
    );
    expect(matchStrength({ known, reported, metadataAgrees: true })).toBe('corroborated');
    expect(matchStrength({ known, reported, metadataAgrees: false })).toBe('hint');
    // another master, or none: never more than a hint, whatever the bytes
    expect(
      matchStrength({ known, reported: { ...reported, cplMasterRecordName: null, sha256 }, metadataAgrees: true }),
    ).toBe('hint');
    expect(isActionable('exact') && isActionable('corroborated') && !isActionable('hint') && !isActionable(null)).toBe(
      true,
    );
  });

  it('corroborates by filename, capture date, type and pixel size', () => {
    const date = Date.parse('2026-06-01T10:00:00Z');
    const assetFields = { assetDate: { value: date } };
    const masterFields = {
      filenameEnc: { value: 'IMG_0001.HEIC', type: 'STRING' },
      resOriginalFileType: { value: 'public.heic' },
      resOriginalWidth: { value: 4032 },
      resOriginalHeight: { value: 3024 },
    };
    const item = {
      originalFilename: 'IMG_0001.HEIC',
      creationDate: '2026-06-01T10:00:00.500Z',
      uti: 'public.heic',
      pixelWidth: 3024,
      pixelHeight: 4032,
    };
    expect(metadataAgrees(item, assetFields, masterFields, decodedName)).toBe(true);
    expect(metadataAgrees({ ...item, originalFilename: 'IMG_0002.HEIC' }, assetFields, masterFields, decodedName)).toBe(
      false,
    );
    expect(
      metadataAgrees({ ...item, creationDate: '2026-06-01T10:00:05Z' }, assetFields, masterFields, decodedName),
    ).toBe(false);
    expect(metadataAgrees({ ...item, uti: 'public.jpeg' }, assetFields, masterFields, decodedName)).toBe(false);
    expect(metadataAgrees({ ...item, pixelWidth: 100 }, assetFields, masterFields, decodedName)).toBe(false);
    // without a filename and date nothing is corroborated
    expect(metadataAgrees({ uti: 'public.heic' }, assetFields, masterFields, decodedName)).toBe(false);
  });

  it('masks the Apple Account', () => {
    expect(maskAppleAccount('alex@icloud.com')).toBe('a•••@icloud.com');
    expect(maskAppleAccount('nonsense')).toBe('•••');
  });
});
