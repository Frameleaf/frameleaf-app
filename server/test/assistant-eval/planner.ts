import z from 'zod';
import { speechQuery } from 'src/utils/speech.js';
import { EvalFilters, filtersSchema } from 'test/assistant-eval/score.js';

const responseSchema = z.strictObject({
  tool: z.literal('search_library'),
  arguments: filtersSchema,
  confidence: z.number().min(0).max(1),
});
const toolSchema = z.toJSONSchema(filtersSchema);
type Catalog = { people: string[]; pets: string[]; places: string[]; albums: string[]; tags: string[] };

/** Prepare the transcript lookup before the plan is counted or sent to the repository. */
export function preparePlan(filters: EvalFilters) {
  const query = filters.spoken ? `"${filters.spoken.replaceAll('"', '')}"` : undefined;
  const speech = query ? { query, clauses: speechQuery(query) } : undefined;
  return { filters, speech };
}

/** Ask a candidate worker for a validated plan. Unsupported responses count as unanswered. */
export async function requestPlan(endpoint: URL, question: string, catalog: Catalog) {
  const response = await fetch(new URL('/assistant/plan', endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
    body: JSON.stringify({ question, language: 'en', today: '2026-11-09', catalog, toolSchema }),
  }).catch((error: unknown) => {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      return null;
    }
    throw error;
  });
  if (!response || response.status === 422) {
    return;
  }
  if (!response.ok) {
    throw new Error(`Planner request failed with HTTP ${response.status}`);
  }
  const parsed = responseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    return;
  }
  const filters = parsed.data.arguments;
  if (
    filters.people?.some((name) => !catalog.people.includes(name)) ||
    filters.pets?.some((name) => !catalog.pets.includes(name))
  ) {
    return;
  }
  try {
    return preparePlan(filters);
  } catch {
    return;
  }
}
