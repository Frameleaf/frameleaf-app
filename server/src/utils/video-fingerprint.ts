/**
 * FL-651: video look-alikes are confirmed by lining up two videos' timelines. Every frame of the
 * seek-bar filmstrip (FL-650: frames at the centre of equal slices of the video) gets a 64-bit
 * difference hash; black, solid and near-flat frames get none, so they can never carry a match.
 * Two videos are the same when, at the best time offset between them, most frames of the part they
 * share match a frame of the other one within a slice, and that part covers most of the shorter one.
 */

/** dHash input: a grayscale grid one pixel wider than high, row by row. */
export const HASH_GRID = { width: 9, height: 8 } as const;
/** Frames whose grid varies less than this (0-255 levels, standard deviation) carry no picture. */
export const MIN_FRAME_DETAIL = 8;
/** The overlap must cover this share of the shorter video, so a shared title card cannot match. */
export const MIN_OVERLAP_COVERAGE = 0.8;
/**
 * ...and at least this share of the longer one, so a short clip of a shared intro cannot join every
 * video that opens with it (and, through it, group them). ponytail: trims keeping under half of a
 * video are not grouped; lower this if owners ask for those.
 */
export const MIN_LONGER_COVERAGE = 0.5;
/** Fewer informative frames than this in the overlap (on either side) is too little to judge. */
export const MIN_COMPARED_FRAMES = 6;
/** Offsets tried in full, the ones most matching frame pairs agree on. */
const OFFSETS_TRIED = 8;

/** Hashes stored as signed 64-bit decimal strings (Postgres bigint), `null` for frames skipped. */
export type VideoFingerprint = { durationMs: number; hashes: Array<string | null> };

export type VideoFingerprintMatch = {
  isDuplicate: boolean;
  /** Time in the second video minus time in the first. */
  offsetMs: number;
  /** The lower of the two sides' matched shares. */
  matchFraction: number;
  coverage: number;
};

/** A frame's difference hash, or `null` when the frame is too flat to tell apart from others. */
export const frameHash = (grid: ArrayLike<number>): string | null => {
  const { width, height } = HASH_GRID;
  let sum = 0;
  for (let index = 0; index < width * height; index++) {
    sum += grid[index];
  }
  const mean = sum / (width * height);
  let variance = 0;
  for (let index = 0; index < width * height; index++) {
    variance += (grid[index] - mean) ** 2;
  }
  if (Math.sqrt(variance / (width * height)) < MIN_FRAME_DETAIL) {
    return null;
  }

  let hash = 0n;
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width - 1; column++) {
      hash = (hash << 1n) | (grid[row * width + column] < grid[row * width + column + 1] ? 1n : 0n);
    }
  }
  return BigInt.asIntN(64, hash).toString();
};

export const hashDistance = (a: bigint, b: bigint) => {
  let bits = BigInt.asUintN(64, a ^ b);
  let count = 0;
  while (bits) {
    bits &= bits - 1n;
    count++;
  }
  return count;
};

type Frame = { timeMs: number; hash: bigint };
type Timeline = { durationMs: number; sliceMs: number; frames: Frame[] };

const toTimeline = ({ durationMs, hashes }: VideoFingerprint): Timeline => {
  const sliceMs = durationMs / Math.max(1, hashes.length);
  const frames: Frame[] = [];
  for (const [index, hash] of hashes.entries()) {
    if (hash !== null) {
      frames.push({ timeMs: sliceMs * (index + 0.5), hash: BigInt(hash) });
    }
  }
  return { durationMs, sliceMs, frames };
};

/** The share of `from`'s frames inside the overlap that match a frame of `to` near the aligned time. */
const matchedShare = (
  from: Timeline,
  to: Timeline,
  offsetMs: number,
  overlap: [number, number],
  toleranceMs: number,
  maxBits: number,
) => {
  let compared = 0;
  let matched = 0;
  for (const frame of from.frames) {
    if (frame.timeMs < overlap[0] || frame.timeMs > overlap[1]) {
      continue;
    }
    compared++;
    const target = frame.timeMs + offsetMs;
    // ponytail: linear scan of ~120 frames; a binary search if filmstrips ever get much longer
    if (
      to.frames.some(
        (other) => Math.abs(other.timeMs - target) <= toleranceMs && hashDistance(frame.hash, other.hash) <= maxBits,
      )
    ) {
      matched++;
    }
  }
  return compared < MIN_COMPARED_FRAMES ? 0 : matched / compared;
};

const evaluate = (a: Timeline, b: Timeline, offsetMs: number, maxBits: number, minMatchFraction: number) => {
  // the part both videos cover, in the first video's time
  const start = Math.max(0, -offsetMs);
  const end = Math.min(a.durationMs, b.durationMs - offsetMs);
  const shorter = Math.min(a.durationMs, b.durationMs);
  const longer = Math.max(a.durationMs, b.durationMs);
  const overlapMs = Math.max(0, end - start);
  const coverage = shorter > 0 ? overlapMs / shorter : 0;
  const toleranceMs = Math.max(a.sliceMs, b.sliceMs);
  const matchFraction =
    coverage > 0
      ? Math.min(
          matchedShare(a, b, offsetMs, [start, end], toleranceMs, maxBits),
          matchedShare(b, a, -offsetMs, [start + offsetMs, end + offsetMs], toleranceMs, maxBits),
        )
      : 0;
  return {
    isDuplicate:
      coverage >= MIN_OVERLAP_COVERAGE &&
      overlapMs >= longer * MIN_LONGER_COVERAGE &&
      matchFraction >= minMatchFraction,
    offsetMs,
    matchFraction,
    coverage,
  };
};

/** Lines two videos up at the offsets their matching frames suggest and keeps the best. */
export const compareVideoFingerprints = (
  first: VideoFingerprint,
  second: VideoFingerprint,
  options: { maxBits: number; minMatchFraction: number },
): VideoFingerprintMatch => {
  const a = toTimeline(first);
  const b = toTimeline(second);
  const bucketMs = Math.max(1, Math.max(a.sliceMs, b.sliceMs) / 2);
  const votes = new Map<number, number>([[0, 0]]);
  for (const x of a.frames) {
    for (const y of b.frames) {
      if (hashDistance(x.hash, y.hash) <= options.maxBits) {
        const bucket = Math.round((y.timeMs - x.timeMs) / bucketMs);
        votes.set(bucket, (votes.get(bucket) ?? 0) + 1);
      }
    }
  }
  const offsets = votes
    .entries()
    .toArray()
    .sort((x, y) => y[1] - x[1])
    .slice(0, OFFSETS_TRIED)
    .map(([bucket]) => bucket * bucketMs);
  if (!offsets.includes(0)) {
    offsets.push(0);
  }

  let best = evaluate(a, b, 0, options.maxBits, options.minMatchFraction);
  for (const offsetMs of offsets) {
    const result = evaluate(a, b, offsetMs, options.maxBits, options.minMatchFraction);
    if (result.isDuplicate !== best.isDuplicate ? result.isDuplicate : result.matchFraction > best.matchFraction) {
      best = result;
    }
  }
  return best;
};

/** A few informative frames from the middle of a video, to find copies whose first frame differs. */
export const middleFrameHashes = ({ hashes }: VideoFingerprint, count = 3): string[] => {
  const picked = new Set<string>();
  for (let index = 1; index <= count; index++) {
    const centre = Math.floor((hashes.length * index) / (count + 1));
    // the nearest informative frame to each quarter point
    for (let step = 0; step < hashes.length; step++) {
      const hash = hashes[centre + step] ?? hashes[centre - step];
      if (hash) {
        picked.add(hash);
        break;
      }
    }
  }
  return [...picked];
};
