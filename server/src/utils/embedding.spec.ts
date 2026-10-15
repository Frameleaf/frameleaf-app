import { dot, l2Normalize, parseEmbedding } from 'src/utils/embedding.js';

describe('embedding utilities', () => {
  it.each(['[1e50, 1]', '[-1e50, 1]'])('rejects Float32 overflow in %s', (raw) => {
    expect(parseEmbedding(raw)).toBeUndefined();
  });

  it('preserves finite Float32 boundary values, whitespace and scientific notation', () => {
    expect(parseEmbedding(' [3.4028234663852886e38, -3.4028234663852886e38, 1e-45, 0.1] ')).toEqual(
      new Float32Array([3.4028234663852886e38, -3.4028234663852886e38, 1e-45, 0.1]),
    );
  });

  it.each([undefined, null, '', '[]', '[1,]', '[NaN]', '[Infinity]', '1, 2'])('rejects malformed %s', (raw) => {
    expect(parseEmbedding(raw)).toBeUndefined();
  });

  it.each([
    '[1garbage]',
    '[1.2.3]',
    '[0x10]',
    '[+1]',
    '[01]',
    '[.5]',
    '[1.]',
    '[1e]',
    '[[1]]',
    '["1"]',
    '[null]',
    '[true]',
    '{}',
    '"[1]"',
  ])('rejects non-JSON numeric vectors %s', (raw) => expect(parseEmbedding(raw)).toBeUndefined());

  it('preserves signed zero and valid JSON number forms', () => {
    const vector = parseEmbedding('[-0, 0, -0.5, 1e+2, 2E-2]')!;
    expect(Object.is(vector[0], -0)).toBe(true);
    expect(vector).toEqual(new Float32Array([-0, 0, -0.5, 100, 0.02]));
  });

  it('normalizes without mutating and preserves zero-vector and dimension-mismatch behavior', () => {
    const vector = new Float32Array([3, 4]);
    const normalized = l2Normalize(vector);
    expect(normalized).toEqual(new Float32Array([0.6, 0.8]));
    expect(vector).toEqual(new Float32Array([3, 4]));
    expect(dot(vector, new Float32Array([2, -1]))).toBe(2);
    expect(dot(vector, new Float32Array([1]))).toBe(0);
    const zero = new Float32Array(2);
    expect(l2Normalize(zero)).toBe(zero);
  });
});
