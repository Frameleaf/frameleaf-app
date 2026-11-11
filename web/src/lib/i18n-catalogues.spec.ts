import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import { readFileSync } from 'node:fs';
import { SHIPPED_LANGUAGES } from '$lib/utils/i18n';

const flatten = (catalogue: Record<string, unknown>, prefix = ''): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(catalogue).flatMap(([key, value]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return value && typeof value === 'object' && !Array.isArray(value)
        ? Object.entries(flatten(value as Record<string, unknown>, path))
        : [[path, value]];
    }),
  );

const readCatalogue = (code: string) => flatten(JSON.parse(readFileSync(`../i18n/${code}.json`, 'utf8')));

const messageContract = (elements: MessageFormatElement[]) => {
  const arguments_ = new Set<string>();
  const tags = new Set<string>();
  const selects = new Set<string>();
  const formats = new Set<string>();
  const plurals = new Set<string>();
  const visit = (elements: MessageFormatElement[]) => {
    for (const element of elements) {
      switch (element.type) {
        case TYPE.literal:
        case TYPE.pound: {
          break;
        }
        case TYPE.tag: {
          tags.add(element.value);
          visit(element.children);
          break;
        }
        default: {
          arguments_.add(element.value);
          if ([TYPE.number, TYPE.date, TYPE.time].includes(element.type)) {
            formats.add(`${element.value}:${element.type}`);
          }
          if (element.type === TYPE.select || element.type === TYPE.plural) {
            if (element.type === TYPE.plural) {
              plurals.add(`${element.value}:${element.pluralType}:${element.offset}`);
            }
            for (const [option, { value }] of Object.entries(element.options)) {
              if (element.type === TYPE.select) {
                selects.add(`${element.value}:${option}`);
              }
              if (element.type === TYPE.plural && option.startsWith('=')) {
                plurals.add(`${element.value}:${element.pluralType}:${element.offset}:${option}`);
              }
              visit(value);
            }
          }
        }
      }
    }
  };
  visit(elements);
  return {
    arguments: [...arguments_].sort(),
    tags: [...tags].sort(),
    selects: [...selects].sort(),
    formats: [...formats].sort(),
    plurals: [...plurals].sort(),
  };
};

const hasCompatibleContract = (source: string, translation: string) => {
  // Plain $t messages allow email addresses in angle brackets; FormatMessage uses closing tags.
  const ignoreTag = !/<\/[\w-]+>/.test(`${source}${translation}`);
  const expected = messageContract(parse(source, { ignoreTag }));
  const actual = messageContract(parse(translation, { ignoreTag }));
  return (
    (['arguments', 'tags', 'selects'] as const).every(
      (field) => JSON.stringify(actual[field]) === JSON.stringify(expected[field]),
    ) &&
    expected.formats.every((format) => actual.formats.includes(format)) &&
    expected.plurals.every((plural) => actual.plurals.includes(plural))
  );
};

describe('translation message contracts', () => {
  it.each([
    ['Hello {name}', 'Hello'],
    ['{count, plural, one {item} other {items}}', '{count} items'],
    ['{count, plural, =0 {none} other {# items}}', '{count, plural, other {# items}}'],
    ['{count, plural, offset:1 other {# items}}', '{count, plural, other {# items}}'],
    ['{count, number}', '{count}'],
    ['{date, date}', '{date}'],
    ['{role, select, owner {Owner} other {Member}}', '{role, select, other {Member}}'],
    ['<link>Hello {name}</link>', 'Hello {name}'],
  ])('rejects a lost message contract in %s', (source, translation) => {
    expect(hasCompatibleContract(source, translation)).toBe(false);
  });

  it('allows additional Polish plural categories and grammar around an unformatted count', () => {
    const polish = '{count, plural, one {# element} few {# elementy} many {# elementów} other {# elementu}}';
    expect(hasCompatibleContract('{count, plural, one {# item} other {# items}}', polish)).toBe(true);
    expect(hasCompatibleContract('{count} item(s)', polish)).toBe(true);
  });
});

describe('shipped translation catalogues', () => {
  const english = readCatalogue('en');

  for (const { code } of SHIPPED_LANGUAGES) {
    describe(code, () => {
      const catalogue = readCatalogue(code);

      it('contains every English key with a nonempty string value', () => {
        const missing = Object.keys(english).filter((key) => !Object.hasOwn(catalogue, key));
        // A new English message needs its translation in every language offered in Settings.
        expect(missing.slice(0, 20), `i18n/${code}.json lacks ${missing.length} keys of i18n/en.json`).toEqual([]);
        const invalid = Object.entries(catalogue)
          .filter(([, value]) => typeof value !== 'string' || !value.trim())
          .map(([key]) => key);
        expect(invalid).toEqual([]);
      });

      it('preserves valid ICU messages, arguments, rich-text tags and select choices', () => {
        const errors: string[] = [];
        for (const [key, value] of Object.entries(catalogue)) {
          if (typeof value !== 'string') {
            continue;
          }
          const source = english[key];
          try {
            if (!hasCompatibleContract(typeof source === 'string' ? source : value, value)) {
              errors.push(`${key}: incompatible message arguments, tags, formats or selectors`);
            }
          } catch (error) {
            errors.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        expect(errors).toEqual([]);
      });
    });
  }
});
