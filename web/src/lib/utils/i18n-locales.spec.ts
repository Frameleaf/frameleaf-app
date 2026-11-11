import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

type Messages = { [key: string]: string | Messages };

const directory = path.resolve(import.meta.dirname, '../../../../i18n');

const flatten = (messages: Messages, prefix = '', flat: Record<string, string> = {}) => {
  for (const [key, value] of Object.entries(messages)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      flat[name] = value;
    } else {
      flatten(value, name, flat);
    }
  }
  return flat;
};

const read = (file: string) => flatten(JSON.parse(readFileSync(path.join(directory, file), 'utf8')) as Messages);

/** Every placeholder and tag name in a message, at any depth. */
const names = (elements: MessageFormatElement[], found = new Set<string>()) => {
  for (const element of elements) {
    if (element.type === TYPE.literal || element.type === TYPE.pound) {
      continue;
    }
    if (element.type === TYPE.tag) {
      found.add(`<${element.value}>`);
      names(element.children, found);
      continue;
    }
    found.add(element.value);
    if (element.type === TYPE.select || element.type === TYPE.plural) {
      for (const option of Object.values(element.options)) {
        names(option.value, found);
      }
    }
  }
  return found;
};

// `$t` formats with tags ignored, so an English string may hold a literal "<" (an email address in
// angle brackets). Its translations are then read the same way; every other string must parse in full.
const english = Object.fromEntries(
  Object.entries(read('en.json')).map(([key, message]) => {
    try {
      return [key, { ignoreTag: false, names: names(parse(message)) }];
    } catch {
      return [key, { ignoreTag: true, names: names(parse(message, { ignoreTag: true })) }];
    }
  }),
);

const locales = readdirSync(directory).filter((file) => file.endsWith('.json') && file !== 'en.json');

describe('translation files', () => {
  it('finds the translation files', () => {
    expect(locales.length).toBeGreaterThan(50);
    expect(Object.keys(english).length).toBeGreaterThan(10_000);
  });

  // A string that fails either check shows its raw text in the app, such as "{count, Number}".
  it.each(locales)('%s parses and uses only the placeholders of the English string', (file) => {
    const problems: string[] = [];
    for (const [key, message] of Object.entries(read(file))) {
      const source = english[key];
      if (!source) {
        continue; // a key English no longer has is never shown
      }
      try {
        const unknown = [...names(parse(message, { ignoreTag: source.ignoreTag }))].filter(
          (name) => !source.names.has(name),
        );
        if (unknown.length > 0) {
          problems.push(`${key}: ${unknown.join(', ')} is not in the English string`);
        }
      } catch (error) {
        problems.push(`${key}: ${(error as Error).message}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
