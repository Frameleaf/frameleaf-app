import { isDeepStrictEqual } from 'node:util';
import z from 'zod';

export const RESULT_LIMIT = 24;

export const filtersSchema = z.strictObject({
  people: z.array(z.string()).min(1).optional(),
  pets: z.array(z.string()).min(1).optional(),
  city: z.string().min(1).optional(),
  takenAfter: z.iso.datetime().optional(),
  takenBefore: z.iso.datetime().optional(),
  type: z.enum(['IMAGE', 'VIDEO']).optional(),
  favorite: z.boolean().optional(),
  ocr: z.string().min(1).optional(),
  spoken: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
});

const assetSchema = filtersSchema.omit({ takenAfter: true, takenBefore: true }).extend({
  key: z.string().min(1),
  filename: z.string().min(1).optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  takenAt: z.iso.datetime(),
  locked: z.boolean().optional(),
  otherOwner: z.boolean().optional(),
});

const caseSchema = z.strictObject({
  id: z.string().min(1),
  family: z.string().min(1),
  question: z.string().min(1),
  expect: z.strictObject({ filters: filtersSchema, assetKeys: z.array(z.string().min(1)) }),
});

export type EvalFilters = z.infer<typeof filtersSchema>;
export type EvalCase = z.infer<typeof caseSchema>;
export type EvalAsset = z.infer<typeof assetSchema>;
export type Reason = { field: keyof EvalFilters | 'takenDate' | 'filename'; value: string | boolean } | null;
export type EvalAnswer = {
  id: string;
  filters: EvalFilters | null;
  hits: { key: string; reasons: Reason[] }[];
  elapsedMs: number;
};

/** Check fixture shape and cross-references before loading PostgreSQL. */
export function readFixtures(cases: unknown, library: unknown, replay: unknown) {
  const questions = z.array(caseSchema).min(200).parse(cases);
  const assets = z.array(assetSchema).min(300).parse(library);
  const plans = z.record(z.string(), filtersSchema).parse(replay);
  const unique = (items: string[]) => new Set(items).size === items.length;
  const visibleKeys = new Set(assets.filter((asset) => !asset.locked && !asset.otherOwner).map(({ key }) => key));
  if (
    !unique(questions.map(({ id }) => id)) ||
    !unique(questions.map(({ question }) => question)) ||
    !unique(assets.map(({ key }) => key)) ||
    Object.keys(plans).length !== questions.length ||
    questions.some(
      ({ id, expect }) =>
        !Object.hasOwn(plans, id) || !unique(expect.assetKeys) || expect.assetKeys.some((key) => !visibleKeys.has(key)),
    )
  ) {
    throw new Error('Invalid assistant evaluation fixture references');
  }
  return { questions, assets, plans };
}

function supports(asset: EvalAsset | undefined, claim: Reason) {
  if (!asset || asset.locked || asset.otherOwner || !claim) {
    return false;
  }
  const { field, value } = claim;
  if (field === 'takenDate') {
    return asset.takenAt.slice(0, 10) === value;
  }
  if (field === 'takenAfter' || field === 'takenBefore') {
    if (typeof value !== 'string') {
      return false;
    }
    const taken = Date.parse(asset.takenAt);
    const bound = Date.parse(value);
    return field === 'takenAfter' ? taken >= bound : taken <= bound;
  }
  const evidence = asset[field];
  if (Array.isArray(evidence)) {
    return typeof value === 'string' && evidence.includes(value);
  }
  if (['ocr', 'spoken', 'description', 'filename'].includes(field)) {
    return (
      typeof value === 'string' && typeof evidence === 'string' && evidence.toLowerCase().includes(value.toLowerCase())
    );
  }
  return evidence === value;
}

const canonical = (filters: EvalFilters) => ({
  ...filters,
  ...(filters.takenAfter && { takenAfter: new Date(filters.takenAfter).toISOString() }),
  ...(filters.takenBefore && { takenBefore: new Date(filters.takenBefore).toISOString() }),
  ...(filters.people && { people: [...filters.people].sort() }),
  ...(filters.pets && { pets: [...filters.pets].sort() }),
});

/** Score answered cases, retaining unanswered cases in the denominator and latency sample. */
export function score(questions: EvalCase[], library: EvalAsset[], answers: EvalAnswer[]) {
  const byId = new Map(answers.map((answer) => [answer.id, answer]));
  if (
    questions.length === 0 ||
    answers.length !== questions.length ||
    byId.size !== questions.length ||
    questions.some(({ id }) => !byId.has(id)) ||
    answers.some(({ elapsedMs }) => !Number.isFinite(elapsedMs) || elapsedMs < 0)
  ) {
    throw new Error('Expected one answer with measured latency per question');
  }
  const assets = new Map(library.map((asset) => [asset.key, asset]));
  let correctFilters = 0;
  let recall = 0;
  let reasons = 0;
  let supported = 0;
  for (const { id, expect } of questions) {
    const { filters, hits } = byId.get(id)!;
    if (!filters) {
      continue;
    }
    correctFilters += Number(isDeepStrictEqual(canonical(filters), canonical(expect.filters)));
    const page = new Map<string, Reason[]>();
    for (const { key, reasons } of hits.slice(0, RESULT_LIMIT)) {
      if (!page.has(key)) {
        page.set(key, reasons);
      }
    }
    recall +=
      expect.assetKeys.length > 0
        ? expect.assetKeys.filter((key) => page.has(key)).length / expect.assetKeys.length
        : Number(page.size === 0);
    for (const [key, claims] of page) {
      reasons += Math.max(1, claims.length);
      supported += claims.filter((claim) => supports(assets.get(key), claim)).length;
    }
  }
  const times = answers.map(({ elapsedMs }) => elapsedMs).sort((a, b) => a - b);
  return {
    filterAccuracy: correctFilters / questions.length,
    recallAt24: recall / questions.length,
    faithfulness: reasons === 0 ? 0 : supported / reasons,
    p95Ms: times[Math.ceil(0.95 * times.length) - 1],
  };
}

/** Diagnose live planner regressions by question family without emitting questions or responses. */
export function scoreByFamily(questions: EvalCase[], library: EvalAsset[], answers: EvalAnswer[]) {
  return Object.fromEntries(
    [...Map.groupBy(questions, ({ family }) => family)].map(([family, cases]) => {
      const ids = new Set(cases.map(({ id }) => id));
      const familyAnswers = answers.filter(({ id }) => ids.has(id));
      return [
        family,
        {
          cases: cases.length,
          validPlanRate: familyAnswers.filter(({ filters }) => filters !== null).length / cases.length,
          ...score(cases, library, familyAnswers),
        },
      ];
    }),
  );
}

/** Count planner filter errors without writing the questions or filter values to the report. */
export function countFilterErrors(questions: EvalCase[], answers: EvalAnswer[]) {
  const byId = new Map(answers.map(({ id, filters }) => [id, filters]));
  const counts = new Map<string, { missing: number; unexpected: number; incorrect: number }>();
  for (const { id, expect } of questions) {
    const filters = byId.get(id);
    if (!filters) {
      continue;
    }
    const expected = canonical(expect.filters);
    const actual = canonical(filters);
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)] as (keyof EvalFilters)[]);
    for (const key of keys) {
      if (isDeepStrictEqual(expected[key], actual[key])) {
        continue;
      }
      const count = counts.get(key) ?? { missing: 0, unexpected: 0, incorrect: 0 };
      const error = actual[key] === undefined ? 'missing' : expected[key] === undefined ? 'unexpected' : 'incorrect';
      count[error]++;
      counts.set(key, count);
    }
  }
  return Object.fromEntries(counts);
}
