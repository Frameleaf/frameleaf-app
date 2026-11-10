/**
 * FL-1385: whether a person's faces fall into two groups that look like two different people.
 *
 * The faces are split in two by how alike they are (two-means on cosine distance, seeded with the
 * face least like the rest). The split counts only when all of these hold:
 * - both groups have at least `minFaces` faces;
 * - the groups' centres are at least `minDistance` apart. Measured with buffalo_l, different people's
 *   centres sit 0.6 or more apart and two halves of one person 0.1 to 0.35;
 * - the smaller group's faces are as alike as one person's (mean distance between them under
 *   `minDistance`), so blurry or half-hidden leftovers, which look like nobody in particular, never
 *   count as a second person.
 *
 * ponytail: a child and the same person grown up can sit as far apart as two people; the owner answers
 * "same person" once. Reading capture dates would tell the two cases apart.
 */
/** Each side of a split needs at least this many faces. */
export const FACE_SPLIT_MIN_FACES = 3;
/** The two groups' centres must be this much farther apart than the recognition distance. */
export const FACE_SPLIT_MARGIN = 0.1;
/** How many of a person's faces the split is looked for in; the rest are sorted by the two centres. */
export const FACE_SPLIT_SAMPLE = 200;

export interface FaceSplit {
  /** Indexes into the input of the smaller group: the faces that may be someone else. */
  smaller: number[];
  larger: number[];
  /** Cosine distance between the two groups' centres. */
  distance: number;
  /** The two groups' centres (unit length), to sort faces that were not in the input. */
  centres: { smaller: number[]; larger: number[] };
}

export interface FaceSplitOptions {
  minDistance: number;
  minFaces?: number;
}

const dot = (a: Float64Array, b: Float64Array) => {
  let sum = 0;
  for (const [index, value] of a.entries()) {
    sum += value * b[index];
  }
  return sum;
};

const unit = (vector: ArrayLike<number>) => {
  const result = Float64Array.from(vector);
  const length = Math.sqrt(dot(result, result)) || 1;
  for (let index = 0; index < result.length; index++) {
    result[index] /= length;
  }
  return result;
};

/** The mean of `faces` (not normalised) and how many there are. */
const mean = (faces: Float64Array[], dimensions: number) => {
  const result = new Float64Array(dimensions);
  for (const face of faces) {
    for (const [index, value] of face.entries()) {
      result[index] += value;
    }
  }
  for (let index = 0; index < dimensions; index++) {
    result[index] /= faces.length || 1;
  }
  return result;
};

const farthestFrom = (faces: Float64Array[], from: Float64Array) => {
  let farthest = 0;
  let lowest = Infinity;
  for (const [index, face] of faces.entries()) {
    const similarity = dot(face, from);
    if (similarity < lowest) {
      lowest = similarity;
      farthest = index;
    }
  }
  return farthest;
};

export const findFaceSplit = (
  embeddings: ArrayLike<number>[],
  { minDistance, minFaces = FACE_SPLIT_MIN_FACES }: FaceSplitOptions,
): FaceSplit | null => {
  if (embeddings.length < minFaces * 2) {
    return null;
  }
  const faces = embeddings.map((embedding) => unit(embedding));
  const dimensions = faces[0].length;

  let second = faces[farthestFrom(faces, unit(mean(faces, dimensions)))];
  let first = faces[farthestFrom(faces, second)];
  let sides: boolean[] = [];
  for (let round = 0; round < 20; round++) {
    const next = faces.map((face) => dot(face, second) > dot(face, first));
    if (round > 0 && next.every((side, index) => side === sides[index])) {
      break;
    }
    sides = next;
    const [a, b] = [faces.filter((_, index) => !sides[index]), faces.filter((_, index) => sides[index])];
    if (a.length === 0 || b.length === 0) {
      return null;
    }
    first = unit(mean(a, dimensions));
    second = unit(mean(b, dimensions));
  }

  const indexes = faces.map((_, index) => index);
  const [a, b] = [indexes.filter((index) => !sides[index]), indexes.filter((index) => sides[index])];
  const [smaller, larger] = a.length <= b.length ? [a, b] : [b, a];
  const centres =
    a.length <= b.length ? { smaller: [...first], larger: [...second] } : { smaller: [...second], larger: [...first] };
  if (smaller.length < minFaces) {
    return null;
  }
  const distance = 1 - dot(first, second);
  if (distance < minDistance) {
    return null;
  }
  // For unit vectors the mean similarity between a group's faces follows from the length of their mean.
  const centre = mean(
    smaller.map((index) => faces[index]),
    dimensions,
  );
  const alike = (smaller.length * dot(centre, centre) - 1) / (smaller.length - 1);
  if (1 - alike >= minDistance) {
    return null;
  }
  return { smaller, larger, distance, centres };
};
