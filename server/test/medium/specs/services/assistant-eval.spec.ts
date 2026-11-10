import assert from 'node:assert/strict';
import { requestPlan } from 'test/assistant-eval/planner.js';
import { run } from 'test/assistant-eval/run.js';
import { type EvalCase, score } from 'test/assistant-eval/score.js';
import thresholds from 'test/assistant-eval/thresholds.json' with { type: 'json' };
import { getActiveForkKyselyDB } from 'test/utils.js';

const mode = process.env.FRAMELEAF_ASSISTANT_EVAL_MODE ?? 'replay';

it(
  'evaluates the fixed assistant corpus against a seeded library',
  async () => {
    const database = await getActiveForkKyselyDB('assistant_eval');
    try {
      const report = await run(database, evaluationOptions());
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
  },
  mode === 'live' ? 30 * 60_000 : 120_000,
);

function evaluationOptions(): Parameters<typeof run>[1] {
  if (mode === 'replay' || mode === 'baseline') {
    return { mode };
  }
  if (mode !== 'live') {
    throw new Error('Expected assistant eval mode replay, baseline, or live');
  }
  const configured = process.env.FRAMELEAF_ASSISTANT_PLANNER_URL;
  if (!configured) {
    throw new Error('Live evaluation requires FRAMELEAF_ASSISTANT_PLANNER_URL');
  }
  const endpoint = new URL(configured);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error('Provide a planner HTTP(S) origin without credentials');
  }
  return { mode, endpoint };
}

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

it('rejects a candidate plan that names a person outside the fixture catalogue', async () => {
  const endpoint = new URL('http://127.0.0.1:3003');
  const candidate = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ tool: 'search_library', confidence: 0.9, arguments: { people: ['Unknown'] } }));
  try {
    const catalog = { people: ['Maya'], pets: [], places: ['Banff'], tags: [], albums: [] };
    await expect(requestPlan(endpoint, 'Show photos of Maya', catalog)).resolves.toBeUndefined();
    expect(candidate).toHaveBeenCalledWith(
      new URL('/assistant/plan', endpoint),
      expect.objectContaining({
        redirect: 'error',
        method: 'POST',
      }),
    );
  } finally {
    candidate.mockRestore();
  }
});
