import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * FL-168: the naming rule for customer-facing copy. The strings people read — `i18n/en.json`, the
 * text of every web component and the Frameleaf Cloud documentation — never say "fork", "DTO" or
 * "worker-admission proof", never name Immich as the product (naming it as the project Frameleaf is
 * built on, `<upstream>Immich</upstream>`, is the attribution) and never name the previous
 * GPU-provider integration. Identifiers such as `@frameleaf/ui`, `frameleaf-server` or `IMMICH_*` are not
 * copy, so the check is case-sensitive and runs on text rather than on code.
 */

const BANNED = /\bImmich\b|\b[Ff]ork(?:s|ed)?\b|\bDTOs?\b|worker-admission proof|\b[Rr]un[Pp]od\b/;

const root = join(import.meta.dirname, '../../../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const flat = (value: Record<string, unknown>, prefix = ''): Array<[string, string]> =>
  Object.entries(value).flatMap(([key, entry]) =>
    typeof entry === 'string'
      ? [[`${prefix}${key}`, entry]]
      : flat(entry as Record<string, unknown>, `${prefix}${key}.`),
  );

const files = (dir: string): string[] =>
  readdirSync(join(root, dir)).flatMap((name) => {
    const path = `${dir}/${name}`;
    return statSync(join(root, path)).isDirectory() ? files(path) : [path];
  });

/** A component's text: its markup without scripts, styles, comments, tags and `{expressions}`. */
const componentText = (source: string) =>
  source
    .replaceAll(/<script[\s\S]*?<\/script>/g, '')
    .replaceAll(/<style[\s\S]*?<\/style>/g, '')
    .replaceAll(/<!--[\s\S]*?-->/g, '')
    .replaceAll(/<[^>]*>/g, ' ')
    .replaceAll(/\{[^{}]*\}/g, ' ');

/** A document's prose: without code, link targets and addresses. */
const prose = (source: string) =>
  source
    .replaceAll(/```[\s\S]*?```/g, '')
    .replaceAll(/`[^`]*`/g, '')
    .replaceAll(/\]\([^)]*\)/g, ']')
    .replaceAll(/^\[[^\]]+\]:.*$/gm, '')
    .replaceAll(/https?:\/\/\S+/g, '');

/** The documentation FL-168 covers: Frameleaf Cloud, its settings, workers, remote access and FAQ. */
const CLOUD_DOCUMENTS = [
  'docs/docs/administration/system-settings.md',
  'docs/docs/administration/workers-and-endpoints.md',
  'docs/docs/guides/remote-access.md',
  'docs/docs/features/user-settings.md',
  'docs/docs/FAQ.mdx',
  'docs/docs/install/environment-variables.md',
];

const offending = (lines: string[]) => lines.filter((line) => BANNED.test(line)).map((line) => line.trim());

describe('customer-facing copy (FL-168 naming rule)', () => {
  it('keeps i18n/en.json free of internal terms and product names', () => {
    const messages = flat(JSON.parse(read('i18n/en.json')) as Record<string, unknown>);
    expect(messages.length).toBeGreaterThan(1000);
    const bad = messages
      .map(([key, text]) => [key, text.replaceAll('<upstream>Immich</upstream>', '')] as const)
      .filter(([, text]) => BANNED.test(text))
      .map(([key]) => key);
    expect(bad).toEqual([]);
  });

  it('keeps i18n/en.json sorted', () => {
    const check = (value: Record<string, unknown>, path: string) => {
      const keys = Object.keys(value);
      expect(keys, path || 'top level').toEqual([...keys].sort());
      for (const [key, entry] of Object.entries(value)) {
        if (entry && typeof entry === 'object') {
          check(entry as Record<string, unknown>, `${path}${key}.`);
        }
      }
    };
    check(JSON.parse(read('i18n/en.json')) as Record<string, unknown>, '');
  });

  it('keeps the text of every web component free of them', () => {
    const components = files('web/src').filter((path) => path.endsWith('.svelte'));
    expect(components.length).toBeGreaterThan(100);
    const bad = components.flatMap((path) =>
      offending(componentText(read(path)).split('\n')).map((line) => `${path}: ${line}`),
    );
    expect(bad).toEqual([]);
  });

  it('keeps the Frameleaf Cloud documentation free of them', () => {
    const bad = CLOUD_DOCUMENTS.flatMap((path) =>
      offending(prose(read(path)).split('\n')).map((line) => `${path}: ${line}`),
    );
    expect(bad).toEqual([]);
  });

  it('catches the terms it is meant to catch', () => {
    for (const text of ['Built on Immich', 'this fork', 'the DTO', 'a worker-admission proof', 'RunPod GPUs']) {
      expect(BANNED.test(text), text).toBe(true);
    }
    for (const text of ['@frameleaf/ui', 'frameleaf-server', 'IMMICH_HOST', 'Frameleaf Cloud', 'forklift']) {
      expect(BANNED.test(text), text).toBe(false);
    }
  });
});
