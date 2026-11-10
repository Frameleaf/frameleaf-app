import assert from 'node:assert/strict';
import { run } from 'test/assistant-eval/run.js';
import { type EvalCase, score } from 'test/assistant-eval/score.js';
import thresholds from 'test/assistant-eval/thresholds.json' with { type: 'json' };
import { getActiveForkKyselyDB } from 'test/utils.js';

it('evaluates the fixed assistant corpus against a seeded library', async () => {
  const database = await getActiveForkKyselyDB('assistant_eval');
  try {
    const mode = process.env.FRAMELEAF_ASSISTANT_EVAL_MODE ?? 'replay';
    if (mode !== 'replay' && mode !== 'baseline') {
      throw new Error('Expected assistant eval mode replay or baseline');
    }
    const report = await run(database, mode);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (mode === 'replay') {
      expect(report.filterAccuracy).toBeGreaterThanOrEqual(thresholds.filterAccuracy);
      expect(report.recallAt24).toBeGreaterThanOrEqual(thresholds.recallAt24);
      expect(report.faithfulness).toBeGreaterThanOrEqual(thresholds.faithfulness);
      expect(report.p95Ms).toBeLessThanOrEqual(thresholds.p95Ms);
    }
  } finally {
    await database.destroy();
  }
}, 120_000);

const asset = { key: 'one', city: 'Banff', type: 'IMAGE', takenAt: '2024-01-10T12:00:00.000Z' } as const;
const question: EvalCase = {
  id: 'city',
  family: 'place-date',
  question: 'Photos in Banff',
  expect: { filters: { city: 'Banff', type: 'IMAGE' }, assetKeys: ['one'] },
};

it('counts only supported reasons and top 24 unique matches', () => {
  const result = score(
    [question],
    [asset],
    [
      {
        id: 'city',
        filters: { type: 'IMAGE', city: 'Banff' },
        hits: [
          {
            key: 'one',
            reasons: [
              { field: 'city', value: 'Banff' },
              { field: 'type', value: 'VIDEO' },
            ],
          },
        ],
        elapsedMs: 75,
      },
    ],
  );
  assert.deepEqual(result, { filterAccuracy: 1, recallAt24: 1, faithfulness: 0.5, p95Ms: 75 });
});

it('penalizes missing reasons, incorrect empty results, and hallucinated fields', () => {
  const result = score(
    [question],
    [asset],
    [
      {
        id: 'city',
        filters: { city: 'Banff', type: 'IMAGE', favorite: true },
        hits: [{ key: 'stranger', reasons: [] }],
        elapsedMs: 2,
      },
    ],
  );
  assert.deepEqual(result, { filterAccuracy: 0, recallAt24: 0, faithfulness: 0, p95Ms: 2 });
});

it('missing answers and duplicated response IDs invalidate a run', () => {
  assert.throws(() => score([question], [asset], []), /one answer/);
  const answer = { id: 'city', filters: {}, hits: [], elapsedMs: 3 };
  assert.throws(() => score([question], [asset], [answer, answer]), /one answer/);
});
