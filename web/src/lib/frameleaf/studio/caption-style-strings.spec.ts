import { IntlMessageFormat } from 'intl-messageformat';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import en from '../../../../../i18n/en.json';
import { CAPTION_STYLE_ENGINE_STRINGS, captionStyleEngineStrings } from './caption-style-strings';

const messages = en as unknown as Record<string, string>;
const translate = (key: string) => String(new IntlMessageFormat(messages[key], 'en').format());

/** The engine's own English for the card, from patch 0168's `en/word-captions.json`. */
function engineEnglish(): Record<string, string> {
  // Specs run from web/.
  const patch = readFileSync('../studio/patches/0168-word-by-word-captions.patch', 'utf8');
  const section = patch.split('diff --git ').find((part) => part.includes('en/word-captions.json'));
  expect(section).toBeTruthy();
  const json = section!
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
  const flat: Record<string, string> = {};
  const walk = (tree: Record<string, unknown>, prefix: string) => {
    for (const [key, value] of Object.entries(tree)) {
      if (typeof value === 'string') {
        flat[`${prefix}${key}`] = value;
      } else {
        walk(value as Record<string, unknown>, `${prefix}${key}.`);
      }
    }
  };
  walk(JSON.parse(json) as Record<string, unknown>, '');
  return flat;
}

describe('FL-640 Caption style card strings', () => {
  it('translates every string the engine card shows', () => {
    const engine = engineEnglish();
    const mapped = Object.values(CAPTION_STYLE_ENGINE_STRINGS).map((entry) => entry.engine);
    expect(new Set(mapped)).toEqual(new Set(Object.keys(engine)));
  });

  it('has the same plain English in the host as the engine, with no run-time values', () => {
    const engine = engineEnglish();
    for (const entry of Object.values(CAPTION_STYLE_ENGINE_STRINGS)) {
      expect(messages[entry.host], entry.host).toBeTruthy();
      expect(messages[entry.host], entry.host).not.toMatch(/\{\w+\}/);
      expect(translate(entry.host), entry.host).toBe(engine[entry.engine]);
    }
  });

  it('hands the engine one string per card message', () => {
    const strings = captionStyleEngineStrings(translate);
    expect(Object.keys(strings)).toEqual(Object.keys(CAPTION_STYLE_ENGINE_STRINGS));
    expect(strings.captionTitle).toBe('Caption style');
    expect(strings.captionWord).toBe('Word by word');
    expect(strings.captionVertical).toBe('Vertical 9:16');
  });
});
