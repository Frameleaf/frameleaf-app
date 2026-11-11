import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import z from 'zod';
import cases from 'test/assistant-eval/cases.json' with { type: 'json' };
import library from 'test/assistant-eval/library.json' with { type: 'json' };
import { requestPlan } from 'test/assistant-eval/planner.js';
import replay from 'test/assistant-eval/replay.json' with { type: 'json' };
import { run } from 'test/assistant-eval/run.js';
import { type EvalCase, score, scoreByFamily } from 'test/assistant-eval/score.js';
import thresholds from 'test/assistant-eval/thresholds.json' with { type: 'json' };
import { getActiveForkKyselyDB } from 'test/utils.js';

const mode = process.env.FRAMELEAF_ASSISTANT_EVAL_MODE ?? 'replay';

it(
  'evaluates the fixed assistant corpus against a seeded library',
  async () => {
    const options = evaluationOptions();
    const identity = options.mode === 'qualification' ? await qualificationIdentity(options.endpoint) : undefined;
    const database = await getActiveForkKyselyDB('assistant_eval');
    try {
      const report = await run(database, options);
      process.stdout.write(`${JSON.stringify(report)}\n`);
      if (['replay', 'assistant', 'qualification'].includes(mode)) {
        expect(report.filterAccuracy).toBeGreaterThanOrEqual(thresholds.filterAccuracy);
        expect(report.recallAt24).toBeGreaterThanOrEqual(thresholds.recallAt24);
        expect(report.faithfulness).toBeGreaterThanOrEqual(thresholds.faithfulness);
        expect(report.p95Ms).toBeLessThanOrEqual(thresholds.p95Ms);
      }
      if (report.mode === 'qualification' && identity && 'plannerAnswers' in report) {
        expect(report.plannerAnswers).toBeGreaterThanOrEqual(Math.ceil(report.cases * thresholds.filterAccuracy));
        expect(report.protectedHits).toBe(0);
        const output = process.env.FRAMELEAF_ASSISTANT_QUALIFICATION_REPORT;
        if (output) {
          const after = await qualificationIdentity(identity.endpoint);
          expect(after).toEqual(identity);
          const { endpoint: _endpoint, ...provenance } = identity;
          await writeFile(output, `${JSON.stringify({ ...report, ...provenance }, null, 2)}\n`, { flag: 'wx' });
        }
      }
    } finally {
      await database.destroy();
    }
  },
  mode === 'live' || mode === 'qualification' ? 35 * 60_000 : 120_000,
);

it.skipIf(mode !== 'replay')(
  'scores real Assistant responses using the worker HTTP contract',
  async () => {
    const plans = new Map(cases.map(({ question, id }) => [question, replay[id as keyof typeof replay]]));
    const worker = createServer((request, response) => {
      if (request.url === '/ping') {
        response.end('pong');
        return;
      }
      if (request.url === '/capabilities') {
        response.setHeader('Content-Type', 'application/json').end(JSON.stringify({ workloads: ['clip'] }));
        return;
      }
      if (request.url !== '/assistant/plan') {
        response.writeHead(404).end();
        return;
      }
      void Array.fromAsync(request)
        .then((chunks) => {
          const { question } = JSON.parse(Buffer.concat(chunks).toString()) as { question: string };
          response
            .setHeader('Content-Type', 'application/json')
            .end(JSON.stringify({ tool: 'search_library', arguments: plans.get(question), confidence: 0.9 }));
        })
        .catch(() => response.writeHead(500).end());
    }).listen(0, '127.0.0.1');
    try {
      await once(worker, 'listening');
      const address = worker.address();
      assert.ok(address && typeof address === 'object');
      const database = await getActiveForkKyselyDB('assistant_http_eval');
      try {
        const report = await run(database, {
          mode: 'qualification',
          endpoint: new URL(`http://127.0.0.1:${address.port}`),
        });
        expect(report).toMatchObject({
          mode: 'qualification',
          plannerAnswers: cases.length,
          protectedHits: 0,
          faithfulness: 1,
        });
        expect(report.filterAccuracy).toBeGreaterThanOrEqual(thresholds.filterAccuracy);
        expect(report.recallAt24).toBeGreaterThanOrEqual(thresholds.recallAt24);
      } finally {
        await database.destroy();
      }
    } finally {
      if (worker.listening) {
        await new Promise<void>((resolve, reject) => worker.close((error) => (error ? reject(error) : resolve())));
      }
    }
  },
  120_000,
);

const OFFLINE_MODES = ['replay', 'baseline', 'assistant'] as const;
const isOffline = (value: string): value is (typeof OFFLINE_MODES)[number] =>
  (OFFLINE_MODES as readonly string[]).includes(value);

function evaluationOptions(): Parameters<typeof run>[1] {
  if (isOffline(mode)) {
    return { mode };
  }
  if (mode !== 'live' && mode !== 'qualification') {
    throw new Error('Expected assistant eval mode replay, baseline, assistant, live, or qualification');
  }
  const configured = process.env.FRAMELEAF_ASSISTANT_PLANNER_URL;
  if (!configured) {
    throw new Error('Live evaluation requires FRAMELEAF_ASSISTANT_PLANNER_URL');
  }
  const endpoint = new URL(configured);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.href !== `${endpoint.origin}/`) {
    throw new Error('Provide a planner HTTP(S) origin without credentials');
  }
  return { mode, endpoint };
}

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const manifestPath = 'machine-learning/frameleaf_ml/models/assistant-planner-models.json';
const plannerManifest = z.array(z.object({ name: z.string(), default: z.boolean().optional() }));
const plannerCapabilities = z.object({
  tasks: z.object({
    'assistant-plan': z.object({ available: z.boolean(), model: z.string().nullable(), reason: z.unknown() }),
  }),
});

async function qualificationIdentity(endpoint: URL) {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const source = git('rev-parse', 'HEAD');
  if (git('status', '--porcelain', '--untracked-files=no')) {
    throw new Error('Qualify a clean candidate checkout');
  }
  const defaults = plannerManifest
    .parse(JSON.parse(git('show', `${source}:${manifestPath}`)))
    .filter((entry) => entry.default);
  if (defaults.length !== 1) {
    throw new Error('The candidate must pin one default Assistant planner');
  }
  const result = await fetch(new URL('/capabilities', endpoint), {
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  });
  if (!result.ok) {
    throw new Error(`Planner capabilities returned HTTP ${result.status}`);
  }
  const { available, model, reason } = plannerCapabilities.parse(await result.json()).tasks['assistant-plan'];
  if (!available || model !== defaults[0].name) {
    throw new Error(`The worker must offer the candidate's default planner: ${String(reason ?? model)}`);
  }
  const corpusDigest = createHash('sha256')
    .update(JSON.stringify([cases, library]))
    .digest('hex');
  return { source, workerModel: model, corpusDigest, endpoint };
}

const asset = { key: 'one', city: 'Banff', type: 'IMAGE', takenAt: '2024-01-10T12:00:00.000Z' } as const;
const question: EvalCase = {
  id: 'city',
  family: 'place-date',
  question: 'Photos in Banff',
  expect: { filters: { city: 'Banff', type: 'IMAGE' }, assetKeys: ['one'] },
};

it('reports live metrics separately for each question family, including unanswered cases', () => {
  const unanswered = { ...question, id: 'unanswered', family: 'people' };
  const result = scoreByFamily(
    [question, unanswered],
    [asset],
    [
      { id: unanswered.id, filters: null, hits: [], elapsedMs: 8000 },
      {
        id: question.id,
        filters: question.expect.filters,
        hits: [{ key: asset.key, reasons: [{ field: 'city', value: 'Banff' }] }],
        elapsedMs: 50,
      },
    ],
  );
  assert.deepEqual(result, {
    'place-date': { cases: 1, validPlanRate: 1, filterAccuracy: 1, recallAt24: 1, faithfulness: 1, p95Ms: 50 },
    people: { cases: 1, validPlanRate: 0, filterAccuracy: 0, recallAt24: 0, faithfulness: 0, p95Ms: 8000 },
  });
});

it('counts only supported reasons', () => {
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
            reasons: [{ field: 'city', value: 'Banff' }, { field: 'type', value: 'VIDEO' }, null],
          },
        ],
        elapsedMs: 75,
      },
    ],
  );
  assert.deepEqual(result, { filterAccuracy: 1, recallAt24: 1, faithfulness: 1 / 3, p95Ms: 75 });
});

it('scores recall and reasons over the same unique hits in the top 24 ranks', () => {
  const page = Array.from({ length: 23 }, (_, index) => ({ ...asset, key: `asset-${index}` }));
  const afterPage = { ...asset, key: 'rank-25' };
  const matchingReason = { field: 'city', value: 'Banff' } as const;
  const mislabeledReason = { field: 'city', value: 'Calgary' } as const;
  const result = score(
    [{ ...question, expect: { ...question.expect, assetKeys: [page[0].key, afterPage.key] } }],
    [...page, afterPage],
    [
      {
        id: question.id,
        filters: question.expect.filters,
        hits: [
          ...page.map(({ key }) => ({ key, reasons: [matchingReason] })),
          { key: page[0].key, reasons: [mislabeledReason] },
          { key: afterPage.key, reasons: [mislabeledReason] },
        ],
        elapsedMs: 2,
      },
    ],
  );
  assert.deepEqual(result, { filterAccuracy: 1, recallAt24: 0.5, faithfulness: 1, p95Ms: 2 });
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

it('scores equivalent capture bounds regardless of fractional-second formatting', () => {
  const expected = { takenAfter: asset.takenAt };
  const actual = { takenAfter: asset.takenAt.replace('.000', '') };
  const result = score(
    [{ ...question, expect: { ...question.expect, filters: expected } }],
    [asset],
    [
      {
        id: question.id,
        filters: actual,
        hits: [
          {
            key: asset.key,
            reasons: [{ field: 'takenAfter', value: actual.takenAfter }],
          },
        ],
        elapsedMs: 2,
      },
    ],
  );
  assert.deepEqual(result, { filterAccuracy: 1, recallAt24: 1, faithfulness: 1, p95Ms: 2 });
});

it('counts a planner timeout as an unanswered case', async () => {
  const candidate = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('Timed out', 'TimeoutError'));
  try {
    const catalog = { people: [], pets: [], places: [], tags: [], albums: [] };
    await expect(requestPlan(new URL('http://127.0.0.1:3003'), 'Find my photos', catalog)).resolves.toBeUndefined();
  } finally {
    candidate.mockRestore();
  }
});

it('gives empty-result credit only to an answered question', () => {
  const expectNoMatches = { ...question, expect: { ...question.expect, assetKeys: [] } };
  const response = { id: question.id, filters: question.expect.filters, hits: [], elapsedMs: 2 };
  const unanswered = { ...response, filters: null };
  assert.equal(score([expectNoMatches], [asset], [response]).recallAt24, 1);
  assert.equal(score([expectNoMatches], [asset], [unanswered]).recallAt24, 0);
});

it('rejects a candidate with an unusable transcript query', async () => {
  const candidate = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ tool: 'search_library', confidence: 0.9, arguments: { spoken: '!!!' } }));
  try {
    const catalog = { people: [], pets: [], places: [], tags: [], albums: [] };
    await expect(requestPlan(new URL('http://127.0.0.1:3003'), 'Find the video', catalog)).resolves.toBeUndefined();
  } finally {
    candidate.mockRestore();
  }
});
