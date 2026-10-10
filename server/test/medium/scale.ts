import { it } from 'vitest';

/**
 * How many items the medium scale specs load. 25,000 is what every run uses, in CI and locally: it
 * is enough for a bounded page, a keyset cursor or a collapsed aggregate to differ visibly from a
 * walk of the whole ledger. `FRAMELEAF_SCALE_ITEMS` runs them larger by hand (500000 is the size
 * they were first calibrated at); counts, budgets and timeouts in the specs follow the size.
 */
const requested = process.env.FRAMELEAF_SCALE_ITEMS;
export const SCALE_ITEMS = requested === undefined || requested === '' ? 25_000 : Number(requested);
if (!Number.isSafeInteger(SCALE_ITEMS) || SCALE_ITEMS < 5000 || SCALE_ITEMS % 5000 !== 0) {
  throw new Error(`FRAMELEAF_SCALE_ITEMS must be a multiple of 5000, got "${requested}"`);
}

/**
 * How many media the four-stage queue pipeline spec runs through the production facade: 3,000 (it
 * was 15,000, twenty-two minutes on a hosted runner). `FRAMELEAF_PIPELINE_MEDIA` runs more by hand.
 */
const pipeline = process.env.FRAMELEAF_PIPELINE_MEDIA;
export const PIPELINE_MEDIA = pipeline === undefined || pipeline === '' ? 3000 : Number(pipeline);
if (!Number.isSafeInteger(PIPELINE_MEDIA) || PIPELINE_MEDIA < 3000 || PIPELINE_MEDIA % 1000 !== 0) {
  throw new Error(`FRAMELEAF_PIPELINE_MEDIA must be a multiple of 1000 from 3000 up, got "${pipeline}"`);
}

/**
 * A test of `SCALE_ITEMS` items: `%i` in its name is the size, and its timeout is `perItemMs` for
 * each item, never under a minute.
 */
export const scaleIt = (name: string, perItemMs: number, run: () => Promise<void>) =>
  it(name.split('%i').join(String(SCALE_ITEMS)), run, Math.max(60_000, Math.ceil(SCALE_ITEMS * perItemMs)));
