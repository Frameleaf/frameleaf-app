import { describe, expect, it } from 'vitest';
import {
  HASH_GRID,
  VideoFingerprint,
  compareVideoFingerprints,
  frameHash,
  hashDistance,
  middleFrameHashes,
} from 'src/utils/video-fingerprint.js';

const options = { maxBits: 8, minMatchFraction: 0.7 };
const FRAMES = 120;

/** A deterministic 64-bit picture hash for scene `scene` of a video made from `seed`. */
const sceneHash = (seed: number, scene: number) => {
  let state = (seed * 7919 + scene * 104_729 + 1) >>> 0;
  let hash = 0n;
  for (let bit = 0; bit < 64; bit++) {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    hash = (hash << 1n) | BigInt((state >>> 16) & 1);
  }
  return BigInt.asIntN(64, hash);
};

type Content = (timeMs: number) => bigint | null;

/** A video of 2-second scenes from `seed`. */
const scenes =
  (seed: number): Content =>
  (timeMs) =>
    sceneHash(seed, Math.floor(timeMs / 2000));

/** Re-encoding flips a few low bits now and then. */
const noisy =
  (content: Content, bits = 3): Content =>
  (timeMs) => {
    const hash = content(timeMs);
    return hash === null ? null : hash ^ (BigInt((1 << bits) - 1) * BigInt(Math.floor(timeMs / 1000) % 2));
  };

const film = (durationMs: number, content: Content): VideoFingerprint => ({
  durationMs,
  hashes: Array.from({ length: FRAMES }, (_, index) => {
    const hash = content((durationMs * (index + 0.5)) / FRAMES);
    return hash === null ? null : hash.toString();
  }),
});

const titled =
  (title: Content, body: Content, durationMs: number): Content =>
  (timeMs) =>
    timeMs < 5000 || timeMs >= durationMs - 5000 ? title(timeMs) : body(timeMs);

describe('frameHash', () => {
  const grid = (pixel: (row: number, column: number) => number) =>
    Array.from({ length: HASH_GRID.width * HASH_GRID.height }, (_, index) =>
      pixel(Math.floor(index / HASH_GRID.width), index % HASH_GRID.width),
    );

  it('skips black, solid and near-flat frames', () => {
    expect(frameHash(grid(() => 0))).toBeNull();
    expect(frameHash(grid(() => 200))).toBeNull();
    expect(frameHash(grid((row, column) => 16 + ((row + column) % 3)))).toBeNull();
  });

  it('hashes brightness steps between neighbours', () => {
    const rising = frameHash(grid((_, column) => column * 20));
    expect(rising).toBe(BigInt.asIntN(64, (1n << 64n) - 1n).toString());
    expect(frameHash(grid((_, column) => 200 - column * 20))).toBe('0');
  });

  it('keeps a picture with a small brightness change within a few bits', () => {
    const picture = (row: number, column: number) => ((row * 37 + column * 91) % 160) + 40;
    const a = BigInt(frameHash(grid(picture))!);
    const b = BigInt(frameHash(grid((row, column) => Math.min(255, picture(row, column) * 1.1 + 5)))!);
    expect(hashDistance(a, b)).toBeLessThanOrEqual(4);
  });
});

describe('hashDistance', () => {
  it('counts differing bits across the sign bit', () => {
    expect(hashDistance(0n, -1n)).toBe(64);
    expect(hashDistance(5n, 6n)).toBe(2);
  });
});

describe('compareVideoFingerprints', () => {
  const original = film(60_000, scenes(1));

  it('groups a re-encode', () => {
    const reencoded = film(60_000, noisy(scenes(1)));
    expect(reencoded.hashes.some((hash, index) => hash !== original.hashes[index])).toBe(true);
    const match = compareVideoFingerprints(original, reencoded, options);
    expect(match).toMatchObject({ isDuplicate: true, offsetMs: 0 });
  });

  it('groups a trimmed copy and finds where it starts', () => {
    const trimmed = film(40_000, (timeMs) => scenes(1)(timeMs + 10_000));
    const match = compareVideoFingerprints(original, trimmed, options);
    expect(match.isDuplicate).toBe(true);
    expect(Math.abs(match.offsetMs + 10_000)).toBeLessThanOrEqual(500);
    expect(compareVideoFingerprints(trimmed, original, options).isDuplicate).toBe(true);
  });

  it('groups a copy with a different start frame', () => {
    const later = film(
      58_500,
      noisy((timeMs) => scenes(1)(timeMs + 1500)),
    );
    expect(compareVideoFingerprints(original, later, options).isDuplicate).toBe(true);
  });

  it('does not group different videos that share a title screen, intro and outro', () => {
    const title = scenes(99);
    const a = film(60_000, titled(title, scenes(2), 60_000));
    const b = film(60_000, titled(title, scenes(3), 60_000));
    const match = compareVideoFingerprints(a, b, options);
    expect(match.isDuplicate).toBe(false);
    expect(match.matchFraction).toBeLessThan(0.3);
  });

  it('does not group a short title-card clip with a long video that opens with it', () => {
    const title = scenes(99);
    const card = film(5000, title);
    const video = film(60_000, titled(title, scenes(2), 60_000));
    expect(compareVideoFingerprints(card, video, options)).toMatchObject({ isDuplicate: false });
  });

  it('does not group black-heavy videos on their few shared frames', () => {
    const blackWith =
      (body: Content): Content =>
      (timeMs) =>
        timeMs >= 20_000 && timeMs < 22_000 ? scenes(5)(timeMs) : body(timeMs);
    const a = film(
      60_000,
      blackWith(() => null),
    );
    const b = film(
      60_000,
      blackWith(() => null),
    );
    expect(compareVideoFingerprints(a, b, options).isDuplicate).toBe(false);
  });

  it('does not group unrelated videos', () => {
    expect(compareVideoFingerprints(original, film(60_000, scenes(4)), options).isDuplicate).toBe(false);
  });
});

describe('middleFrameHashes', () => {
  it('picks the nearest informative frame to each quarter point', () => {
    const hashes = Array.from({ length: 12 }, (_, index) => (index % 4 === 3 ? String(index) : null));
    expect(middleFrameHashes({ durationMs: 12_000, hashes })).toEqual(['3', '7', '11']);
    expect(middleFrameHashes({ durationMs: 1000, hashes: [null, null] })).toEqual([]);
  });
});
