import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CLIP_MODEL_INFO } from 'src/constants.js';
import { getAestheticHead, parseAestheticHead, scoreAesthetic } from 'src/utils/aesthetic-head.js';

const key = `clip:${'a'.repeat(64)}`;
const head = (layers: Array<{ weights: number[][]; bias: number[] }>) =>
  parseAestheticHead({ modelName: 'm', producerModelKey: key, scoreVersion: 2, layers });

describe('aesthetic heads', () => {
  it('scores sigmoid(head(embedding)) with ReLU between layers', () => {
    const twoLayer = head([
      {
        weights: [
          [1, -1],
          [2, 0],
        ],
        bias: [0, 0],
      },
      { weights: [[1], [1]], bias: [0.5] },
    ]);
    // hidden = relu([1*1 + 2*1, -1*1]) = [3, 0]; logit = 3 + 0 + 0.5
    expect(scoreAesthetic(twoLayer, [1, 1])).toBeCloseTo(1 / (1 + Math.exp(-3.5)));
    expect(scoreAesthetic(twoLayer, [1, 1, 1])).toBeNull();
  });

  it('refuses heads whose layers do not chain to one logit', () => {
    expect(() => head([{ weights: [[1, 1]], bias: [0, 0] }])).toThrow();
    expect(() => head([{ weights: [[1], [1]], bias: [0, 0] }])).toThrow();
  });

  it('keeps version 1 for models without a head and never reads outside the heads folder', () => {
    expect(getAestheticHead('no-such-model')).toBeNull();
    expect(getAestheticHead('../desktop/model-pins')).toBeNull();
  });

  it('ships valid heads under 2 MB, each named after a known model and sized for its embedding', () => {
    const dir = join(import.meta.dirname, '../../resources/aesthetic-heads');
    const files = readdirSync(dir).filter((file) => file.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(statSync(join(dir, file)).size).toBeLessThan(2_000_000);
      const parsed = parseAestheticHead(JSON.parse(readFileSync(join(dir, file), 'utf8')));
      expect(`${parsed.modelName}.json`).toBe(file);
      expect(parsed.layers[0].weights).toHaveLength(CLIP_MODEL_INFO[parsed.modelName].dimSize);
      expect(getAestheticHead(parsed.modelName)).toEqual(parsed);
    }
  });
});
