export const MIN_STYLE_EDITS = 50;
// The Develop Auto control is the comparison baseline.
const AUTO_STYLE_TONE: Partial<Sliders> = {
  exposure: 0.15,
  contrast: 12,
  highlights: -22,
  shadows: 18,
  whites: 8,
  blacks: -6,
  vibrance: 14,
  clarity: 6,
};

export const STYLE_SLIDERS = [
  'exposure',
  'contrast',
  'highlights',
  'shadows',
  'whites',
  'blacks',
  'temperature',
  'tint',
  'vibrance',
  'saturation',
  'clarity',
] as const;

type Sliders = Record<(typeof STYLE_SLIDERS)[number], number>;
export type StyleSample = { image: number[]; embedding?: Float32Array; sliders: Sliders };
export type StyleModel = { imageSize: number; embeddingMean: number[]; axes: number[][]; coefficients: number[][] };

export function extractStyleFeatures(pixels: Uint8Array, channels: number): number[] {
  if (!Number.isInteger(channels) || channels < 3 || !pixels.length || pixels.length % channels) {
    throw new Error('Style features require interleaved RGB pixels');
  }
  const histogram = new Uint32Array(256);
  const count = pixels.length / channels;
  let chroma = 0;
  let warmth = 0;
  for (let index = 0; index < pixels.length; index += channels) {
    const [red, green, blue] = pixels.subarray(index, index + 3);
    const luminance = Math.round(red * 0.2126 + green * 0.7152 + blue * 0.0722);
    histogram[luminance]++;
    chroma += Math.max(red, green, blue) - Math.min(red, green, blue);
    warmth += red - blue;
  }
  const quantile = (fraction: number) => {
    let seen = 0;
    return histogram.findIndex((bin) => (seen += bin) >= count * fraction) / 255;
  };
  return [0.05, 0.25, 0.5, 0.75, 0.95].map(quantile).concat(chroma / count / 255, warmth / count / 255);
}

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let value = 0;
  for (let i = 0; i < a.length; i++) value += a[i] * b[i];
  return value;
};

function embeddingAxes(embeddings: Float32Array[]) {
  const dimensions = embeddings[0]?.length ?? 0;
  const embeddingMean = Array.from(
    { length: dimensions },
    (_, i) => embeddings.reduce((sum, row) => sum + row[i], 0) / embeddings.length,
  );
  const rows = embeddings.map((row) => Float64Array.from(row, (value, i) => value - embeddingMean[i]));
  const axes: number[][] = [];
  for (let component = 0; component < Math.min(16, dimensions, rows.length - 1); component++) {
    let seed = rows[0];
    let largest = -1;
    for (const row of rows) {
      const variance = dot(row, row);
      if (variance > largest) {
        largest = variance;
        seed = row;
      }
    }
    if (largest < 1e-12) break;
    let direction = Float64Array.from(seed, (value) => value / Math.sqrt(largest));
    for (let iteration = 0; iteration < 10; iteration++) {
      const next = new Float64Array(dimensions);
      for (const row of rows) {
        const weight = dot(direction, row);
        for (let i = 0; i < dimensions; i++) next[i] += weight * row[i];
      }
      const length = Math.sqrt(dot(next, next));
      if (length < 1e-12) break;
      direction = next.map((value) => value / length);
    }
    axes.push(Array.from(direction));
    for (const row of rows) {
      const projection = dot(row, direction);
      for (let i = 0; i < dimensions; i++) row[i] -= projection * direction[i];
    }
  }
  return { embeddingMean, axes };
}

function styleInputs(model: Pick<StyleModel, 'axes' | 'embeddingMean'>, image: number[], embedding?: Float32Array) {
  const centered =
    embedding?.length === model.embeddingMean.length
      ? Float64Array.from(embedding, (value, i) => value - model.embeddingMean[i])
      : undefined;
  return [1, ...image, ...model.axes.map((axis) => (centered ? dot(axis, centered) : 0))];
}

export function fitDevelopStyle(samples: StyleSample[], requireMinimum = true): StyleModel {
  if (!samples.length || (requireMinimum && samples.length < MIN_STYLE_EDITS))
    throw new Error('More edited photos are needed');
  const dimensions = samples.find((sample) => sample.embedding)?.embedding?.length;
  const embeddings = samples.flatMap(({ embedding }) =>
    embedding && embedding.length === dimensions ? [embedding] : [],
  );
  const model = embeddingAxes(embeddings);
  const inputs = samples.map(({ image, embedding }) => styleInputs(model, image, embedding));
  const size = inputs[0].length;
  const outputs = STYLE_SLIDERS.length;
  const matrix = Array.from({ length: size }, (_, i) => {
    const terms = new Float64Array(size + outputs);
    if (i > 0) terms[i] = 0.01;
    for (const [index, row] of inputs.entries()) {
      for (let j = 0; j < size; j++) terms[j] += row[i] * row[j];
      for (let j = 0; j < outputs; j++) terms[size + j] += row[i] * samples[index].sliders[STYLE_SLIDERS[j]];
    }
    return terms;
  });
  // The intercept is unpenalized. A positive ridge penalty makes every remaining pivot nonzero.
  for (let i = 0; i < size; i++) {
    const pivot = matrix[i][i];
    for (let j = i; j < size + outputs; j++) matrix[i][j] /= pivot;
    for (let row = 0; row < size; row++) {
      if (row === i) continue;
      const factor = matrix[row][i];
      for (let j = i; j < size + outputs; j++) matrix[row][j] -= factor * matrix[i][j];
    }
  }
  return { ...model, imageSize: samples[0].image.length, coefficients: matrix.map((row) => [...row.subarray(size)]) };
}

export function predictDevelopStyle(model: StyleModel, image: number[], embedding?: Float32Array): Sliders {
  if (image.length !== model.imageSize) throw new Error('The preview features do not match this style profile');
  const input = styleInputs(model, image, embedding);
  return Object.fromEntries(
    STYLE_SLIDERS.map((key, output) => [
      key,
      model.coefficients.reduce((prediction, row, i) => prediction + row[output] * input[i], 0),
    ]),
  ) as Sliders;
}

export function validateDevelopStyle(samples: StyleSample[]) {
  if (samples.length < MIN_STYLE_EDITS) return false;
  const training = samples.filter((_, index) => index % 5 !== 0);
  const heldOut = samples.filter((_, index) => index % 5 === 0);
  const model = fitDevelopStyle(training, false);
  let predictedError = 0;
  let baselineError = 0;
  for (const sample of heldOut) {
    const predicted = predictDevelopStyle(model, sample.image, sample.embedding);
    for (const key of STYLE_SLIDERS) {
      const scale = key === 'exposure' ? 2 : 100;
      predictedError += Math.abs(predicted[key] - sample.sliders[key]) / scale;
      baselineError += Math.abs((AUTO_STYLE_TONE[key] ?? 0) - sample.sliders[key]) / scale;
    }
  }
  return predictedError < baselineError;
}
