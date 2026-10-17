import { cleanup, render } from '@testing-library/svelte';
import { DateTime } from 'luxon';
import GithubLink from '../../../../packages/ui/dist/components/GithubLink/GithubLink.svelte';
import Link from '../../../../packages/ui/dist/components/Link/Link.svelte';
import {
  asGithubLink,
  asQueryString,
  asText,
  isEnabled,
  isExternalLink,
  navigateTo,
  resolveMetadata,
  resolveUrl,
} from '../../../../packages/ui/dist/utilities/common.js';

const navigation = vi.hoisted(() => ({ goto: vi.fn() }));
vi.mock('$app/navigation', () => ({ goto: navigation.goto }));

beforeEach(() => {
  navigation.goto.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('location', new URL('https://photos.frameleaf.cloud/library?at=one#photo'));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  ['/photos?at=one#photo', '/photos?at=one#photo', false],
  ['../albums?sort=new#cover', '../albums?sort=new#cover', false],
  ['#photo', '#photo', false],
  [
    'https://photos.frameleaf.cloud/albums?sort=new#cover',
    'https://photos.frameleaf.cloud/albums?sort=new#cover',
    false,
  ],
  [
    'https://docs.frameleaf.cloud/path?query=a%20b#heading',
    'https://docs.frameleaf.cloud/path?query=a%20b#heading',
    true,
  ],
  ['//docs.frameleaf.cloud/path?q=one#heading', 'https://docs.frameleaf.cloud/path?q=one#heading', true],
  // eslint-disable-next-line unicorn/prefer-https -- A scheme change must remain a different origin.
  ['http://photos.frameleaf.cloud/path?q=one#heading', 'http://photos.frameleaf.cloud/path?q=one#heading', true],
  ['mailto:team@example.test', 'mailto:team@example.test', true],
  ['http://[', 'http://[', false],
])('keeps native URL components for %s', (href, expected, external) => {
  expect(resolveUrl(href)).toBe(expected);
  expect(isExternalLink(href)).toBe(external);
});

it('keeps a different origin external even when its hostname resembles an older app host', () => {
  vi.stubGlobal('location', new URL('https://pr-1.immich.app/gallery'));
  const target = 'https://immich.app/path?query=one#heading';
  expect(resolveUrl(target)).toBe(target);
  expect(resolveUrl(target, 'immich.app')).toBe(target);
  const view = render(Link, { href: target });
  const link = view.getByRole('link');
  expect(link).toHaveAttribute('href', target);
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
});

it('awaits internal navigation with its full query and fragment', async () => {
  let finish = () => {};
  navigation.goto.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  let completed = false;
  const promise = navigateTo('/photos?at=one#photo').then(() => (completed = true));
  await Promise.resolve();
  expect(completed).toBe(false);
  expect(navigation.goto).toHaveBeenCalledWith('/photos?at=one#photo');
  finish();
  await promise;
  expect(completed).toBe(true);
});

it('opens an external URL without navigating the current app', async () => {
  const opened = vi.spyOn(globalThis, 'open').mockReturnValue(null);
  await navigateTo('https://docs.frameleaf.cloud/path?q=one#heading');
  expect(opened).toHaveBeenCalledWith('https://docs.frameleaf.cloud/path?q=one#heading', '_blank', 'noreferrer');
  expect(navigation.goto).not.toHaveBeenCalled();
});

it('propagates a rejected internal navigation', async () => {
  const failure = new Error('navigation failed');
  navigation.goto.mockRejectedValue(failure);
  await expect(navigateTo('/photos')).rejects.toBe(failure);
});

it('preserves URLs when browser location is unavailable during SSR', () => {
  vi.stubGlobal('location', undefined);
  expect(resolveUrl('https://docs.frameleaf.cloud/path?q=one#heading')).toBe(
    'https://docs.frameleaf.cloud/path?q=one#heading',
  );
  expect(isExternalLink('/photos')).toBe(false);
});

it('links a plain PR number to the app repository', () => {
  expect(asGithubLink(140)).toEqual({ href: 'https://github.com/Frameleaf/frameleaf-app/pull/140', text: '#140' });
  const view = render(GithubLink, { number: 140, icon: false });
  expect(view.getByRole('link', { name: '#140' })).toHaveAttribute(
    'href',
    'https://github.com/Frameleaf/frameleaf-app/pull/140',
  );
});

it.each([
  [{ org: 'Frameleaf', repo: 'frameleaf-app', number: 7, type: 'issue' }, 'Frameleaf/frameleaf-app/issues/7', '#7'],
  [{ org: 'Frameleaf', repo: 'tools', number: 8, type: 'discussion' }, 'Frameleaf/tools/discussions/8', 'tools/#8'],
  [{ org: 'sveltejs', repo: 'kit', number: 9, type: 'pr' }, 'sveltejs/kit/pull/9', 'sveltejs/kit#9'],
  [{ org: 'tools', repo: 'tools', number: 3, type: 'issue' }, 'tools/tools/issues/3', 'tools/#3'],
] as const)('keeps explicit repository and link-type choices', (options, path, text) => {
  expect(asGithubLink(options)).toEqual({ href: `https://github.com/${path}`, text });
});

it('encodes query values in insertion order without changing spaces or empty-value options', () => {
  const values = { query: 'a b&c', empty: '', zero: 0, absent: undefined };
  expect(asQueryString(values)).toBe('?query=a%20b%26c&zero=0');
  expect(asQueryString(values, { skipEmptyStrings: false })).toBe('?query=a%20b%26c&empty=&zero=0');
  expect(asQueryString()).toBe('');
});

it('preserves runtime null and boolean values with the existing null-skip option', () => {
  const values = { yes: true, no: false, nil: null, empty: '' };
  expect(Reflect.apply(asQueryString, undefined, [values])).toBe('?yes=true&no=false');
  expect(Reflect.apply(asQueryString, undefined, [values, { skipNullValues: false, skipEmptyStrings: false }])).toBe(
    '?yes=true&no=false&nil=null&empty=',
  );
});

it('preserves metadata fallbacks, empty overrides and date object conversion', () => {
  const site = { title: 'Frameleaf', description: 'Photos', imageUrl: '/default.png' };
  expect(resolveMetadata(site)).toEqual({
    type: 'website',
    siteName: 'Frameleaf',
    title: 'Frameleaf',
    description: 'Photos',
    imageUrl: '/default.png',
    article: undefined,
  });
  expect(resolveMetadata(site, { title: 'Album', description: '', imageUrl: '' })).toEqual({
    type: 'website',
    siteName: 'Frameleaf — Photos',
    title: 'Album | Frameleaf',
    description: '',
    imageUrl: '',
    article: undefined,
  });
  const authors = ['AJ'];
  const publishedTime = DateTime.fromISO('2026-10-13T12:00:00Z', { zone: 'UTC' });
  const article = resolveMetadata(site, undefined, { publishedTime, authors });
  expect(article.type).toBe('article');
  expect(article.article?.publishedTime).toBe('2026-10-13T12:00:00.000Z');
  expect(article.article?.authors).toBe(authors);
  expect(article.article?.modifiedTime).toBeUndefined();
});

it('keeps search text coercion and conditional action receiver semantics', () => {
  expect(asText(null, 'ÉCOLE', undefined, 0, false, Symbol('Tag'))).toBe('école|0|false|symbol(tag)');
  expect(isEnabled({})).toBe(true);
  let enabled = false;
  const action = {
    $if(this: undefined) {
      expect(this).toBeUndefined();
      return enabled;
    },
  };
  expect(isEnabled(action)).toBe(false);
  enabled = true;
  expect(isEnabled(action)).toBe(true);
});
