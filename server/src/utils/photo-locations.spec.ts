import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  locationInsightSchema,
  photoGpsAccuracy,
  validPhotoCoordinates,
  writeLocationInput,
} from 'src/utils/photo-locations.js';

describe('photo location input', () => {
  it('treats unsupported optional accuracy as unknown instead of blocking a library scan', () => {
    expect(photoGpsAccuracy(100_001)).toBeNull();
    expect(photoGpsAccuracy(Infinity)).toBeNull();
    expect(photoGpsAccuracy(-1)).toBeNull();
    expect(photoGpsAccuracy(0)).toBe(0);
    expect(photoGpsAccuracy(12)).toBe(12);
  });
  it('accepts zero on either axis, rejecting invalid coordinates and the missing-fix sentinel', () => {
    expect(validPhotoCoordinates(0, 12)).toBe(true);
    expect(validPhotoCoordinates(12, 0)).toBe(true);
    for (const [lat, lon] of [
      [0, 0],
      [91, 0],
      [0, 181],
      [NaN, 3],
      [null, 4],
    ]) {
      expect(validPhotoCoordinates(lat, lon)).toBe(false);
    }
  });

  it('streams one gzip JSON document with only opaque keys and GPS fields, with its compressed digest', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'frameleaf-locations-test-'));
    try {
      const path = join(folder, 'input.json.gz');
      async function* points() {
        await Promise.resolve();
        yield { itemKey: 'opaque-1', latitude: 49.1, longitude: -123.2, accuracyM: 5 };
        yield { itemKey: 'opaque-2', latitude: 50, longitude: -120 };
      }
      const info = await writeLocationInput(path, 'scan', points());
      const compressed = await readFile(path);
      expect(JSON.parse(gunzipSync(compressed).toString())).toEqual({
        schemaVersion: 1,
        scanId: 'scan',
        points: [
          { itemKey: 'opaque-1', latitude: 49.1, longitude: -123.2, accuracyM: 5 },
          { itemKey: 'opaque-2', latitude: 50, longitude: -120 },
        ],
      });
      expect(info).toEqual({
        pointCount: 2,
        compressedBytes: compressed.length,
        sha256: createHash('sha256').update(compressed).digest('hex'),
      });
      await expect(writeLocationInput(path, 'scan', points(), { expanded: 50, compressed: 128 })).rejects.toThrow(
        'too large',
      );
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('refuses provider links outside Google Maps and strips unexpected result fields', () => {
    const match = {
      provider: 'google',
      placeId: 'place',
      name: 'Cafe',
      address: null,
      mapsUrl: 'https://www.google.com/maps/search/?api=1&query=Cafe&query_place_id=place',
      relation: 'near',
      confidence: 'medium',
      distanceM: 25,
      matchedAt: '2026-10-31T12:00:00Z',
      attributions: [],
    };
    expect(locationInsightSchema.parse({ ...match, privateData: 'drop' })).toEqual(match);
    expect(locationInsightSchema.safeParse({ ...match, mapsUrl: 'https://example.com/' }).success).toBe(false);
    expect(locationInsightSchema.safeParse({ ...match, distanceM: -1 }).success).toBe(false);
  });
});
