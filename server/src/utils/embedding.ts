/**
 * Small vector helpers shared by the CLIP-based enrichment features
 * (zero-shot tagging, smart-album CLIP query matching).
 */

export const parseEmbedding = (raw: string | undefined | null): Float32Array | undefined => {
  if (!raw) {
    return;
  }
  let values: unknown;
  try {
    values = JSON.parse(raw);
  } catch {
    return;
  }
  if (!Array.isArray(values) || values.length === 0) {
    return;
  }
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    if (typeof values[i] !== 'number') {
      return;
    }
    out[i] = values[i];
    if (!Number.isFinite(out[i])) {
      return;
    }
  }
  return out;
};

export const l2Normalize = (vector: Float32Array): Float32Array => {
  let sumSq = 0;
  for (const v of vector) {
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq);
  if (norm === 0) {
    return vector;
  }
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) {
    out[i] = vector[i] / norm;
  }
  return out;
};

export const dot = (a: Float32Array, b: Float32Array): number => {
  if (a.length !== b.length) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
};
