import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESCRIPTION_TAG_STOP_WORDS } from 'src/utils/description-tag-stop-words.js';

/** Every word in the ML service's `TAG_STOP_WORDS` frozenset, read from its source. */
const readMlStopWords = () => {
  const source = readFileSync(
    join(import.meta.dirname, '../../../machine-learning/frameleaf_ml/models/image_description.py'),
    'utf8',
  );
  const start = source.indexOf('TAG_STOP_WORDS = frozenset(');
  expect(start).toBeGreaterThanOrEqual(0);
  const block = source.slice(start, source.indexOf('\n)\n', start));
  return new Set(block.matchAll(/"([^"]*)"\.split\(\)/g).flatMap(([, words]) => words.split(/\s+/)));
};

describe('DESCRIPTION_TAG_STOP_WORDS (FL-667)', () => {
  it('matches the ML service stop list word for word', () => {
    const ml = readMlStopWords();
    expect(ml.size).toBeGreaterThan(100);
    expect([...DESCRIPTION_TAG_STOP_WORDS].toSorted()).toEqual([...ml].toSorted());
  });

  it('holds the filler words the issue names', () => {
    for (const word of ['her', 'behind', 'four']) {
      expect(DESCRIPTION_TAG_STOP_WORDS.has(word)).toBe(true);
    }
    expect(DESCRIPTION_TAG_STOP_WORDS.has('dog')).toBe(false);
  });
});
