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

/**
 * The voice rule (BRAND.md, decision 10): short, plain, reassuring. Copy never congratulates itself
 * ("successfully"), never shouts, never apologises or pleads, and never describes the software
 * ("Unable to", "Failed to", "An error occurred") when it can say what is still true and what to do.
 */
const SHOUTING = /successfully|!|\b(?:oops|whoops|sorry)\b/i;
const VOICE_BANNED = new RegExp(
  `${SHOUTING.source}|\\bplease\\b|\\bassets?\\b|\\bunable to\\b|\\bfailed to\\b|\\berror occurred\\b`,
  'i',
);

/** Keys written for Frameleaf: `frameleaf_*` at the top level and inside `admin`, `errors` and the groups. */
const isFrameleafKey = (key: string) => /(?:^|\.)frameleaf_/.test(key);

/** Frameleaf keys allowed to break the voice rule, each with its reason. */
const VOICE_EXCEPTIONS: Record<string, string> = {
  frameleaf_ack_group_studio_assets: 'the acknowledgements heading for the fonts and tools Studio bundles, not photos',
};

/**
 * Inherited keys that still shout or say "successfully". None is read by the web app (no reference
 * under `web/src`), so their wording is left as it was; a key that the web app starts to use comes
 * off this list and gets rewritten.
 */
const SHOUTING_EXCEPTIONS = new Set([
  'admin.note_cannot_be_changed_later',
  'admin.paths_validated_successfully',
  'advanced_settings_clear_image_cache_success',
  'assets_restore_confirmation',
  'bulk_delete_duplicates_confirmation',
  'empty_trash_confirmation',
  'pin_code_changed_successfully',
  'reset_sqlite_success',
  'setting_image_viewer_original_subtitle',
]);

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

  it('keeps Frameleaf copy in the brand voice', () => {
    const messages = flat(JSON.parse(read('i18n/en.json')) as Record<string, unknown>);
    const frameleaf = messages.filter(([key]) => isFrameleafKey(key));
    expect(frameleaf.length).toBeGreaterThan(1000);
    const bad = frameleaf
      .filter(([key, text]) => !(key in VOICE_EXCEPTIONS) && VOICE_BANNED.test(text))
      .map(([key, text]) => `${key}: ${text}`);
    expect(bad).toEqual([]);
    // An exception that no longer needs to be one is removed, so the list cannot grow stale.
    const texts = new Map(messages);
    expect(Object.keys(VOICE_EXCEPTIONS).filter((key) => !VOICE_BANNED.test(texts.get(key) ?? ''))).toEqual([]);
  });

  it('never says "successfully" or shouts, in any key the web app reads', () => {
    const messages = flat(JSON.parse(read('i18n/en.json')) as Record<string, unknown>);
    const bad = messages
      .filter(([key, text]) => !SHOUTING_EXCEPTIONS.has(key) && SHOUTING.test(text))
      .map(([key, text]) => `${key}: ${text}`);
    expect(bad).toEqual([]);
    const texts = new Map(messages);
    expect([...SHOUTING_EXCEPTIONS].filter((key) => !SHOUTING.test(texts.get(key) ?? ''))).toEqual([]);
    // The exceptions are only for keys the web app does not read.
    const source = files('web/src')
      .filter((path) => /\.(?:svelte|ts)$/.test(path) && !path.endsWith('.spec.ts'))
      .map((path) => read(path))
      .join('\n');
    const leaf = (key: string) => key.split('.').at(-1)!;
    expect([...SHOUTING_EXCEPTIONS].filter((key) => new RegExp(`\\b${leaf(key)}\\b`).test(source))).toEqual([]);
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
    for (const text of [
      'Edits applied successfully',
      'Copied to clipboard!',
      'Oops, try that again',
      'Please check your inbox',
      'Removed 3 assets',
      'Unable to load albums',
      'Failed to delete backup.',
      'An error occurred',
    ]) {
      expect(VOICE_BANNED.test(text), text).toBe(true);
    }
    for (const text of ['Edits saved', 'Your albums did not load. Try again.', 'Removed 3 items', 'A pleased owner']) {
      expect(VOICE_BANNED.test(text), text).toBe(false);
    }
  });
});
