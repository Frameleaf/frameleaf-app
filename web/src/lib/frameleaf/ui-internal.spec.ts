import { cleanup, render } from '@testing-library/svelte';
import CommandPaletteItem from '../../../../packages/ui/dist/components/CommandPalette/CommandPaletteItem.svelte';
import {
  asArray,
  cleanClass,
  escapeHtml,
  generateId,
  highlightHtml,
  isIconLike,
  resolveIcon,
} from '../../../../packages/ui/dist/utilities/internal.js';

afterEach(cleanup);

it.each([
  ['Tom & Jerry', ['&'], 'Tom <mark>&amp;</mark> Jerry'],
  ['<img src=x onerror="alert(1)">', ['<img'], '<mark>&lt;img</mark> src=x onerror=&quot;alert(1)&quot;&gt;'],
  ['A&B', ['amp'], 'A&amp;B'],
  ['<tag>', ['lt'], '&lt;tag&gt;'],
  ['"text"', ['quot'], '&quot;text&quot;'],
  ['BACKUP back Backup', ['back', 'backup'], '<mark>BACKUP</mark> <mark>back</mark> <mark>Backup</mark>'],
  ['a+b [value]', ['a+b', '[value]'], '<mark>a+b</mark> <mark>[value]</mark>'],
  ['<&"\'>', [], '&lt;&amp;&quot;&#39;&gt;'],
  ['École & café', ['café'], 'École &amp; <mark>café</mark>'],
  ['name name', ['', 'name', 'name'], '<mark>name</mark> <mark>name</mark>'],
] as const)('highlights original text safely: %s', (text, highlights, html) => {
  expect(highlightHtml(text, [...highlights])).toBe(html);
  const element = document.createElement('div');
  element.innerHTML = html;
  expect(element.textContent).toBe(text);
  expect(element.querySelectorAll('img, script, iframe')).toHaveLength(0);
});

it('renders literal markup and its highlighted punctuation in the actual command-palette item', () => {
  const description = '<img src=x onerror="alert(1)"> Tom & Jerry';
  const { container, getByRole } = render(CommandPaletteItem, {
    item: { title: 'Safe result', description, highlights: ['<img', '&'], onAction: () => {} },
    selected: false,
    onSelect: () => {},
  });
  expect(getByRole('button')).toHaveTextContent(description);
  expect([...container.querySelectorAll('mark')].map((element) => element.textContent)).toEqual(['<img', '&']);
  expect(container.querySelectorAll('img, script, iframe')).toHaveLength(0);
});

it.each([
  ['', ''],
  ['<&>"\'', '&lt;&amp;&gt;&quot;&#39;'],
  ['&lt;already&gt;', '&amp;lt;already&amp;gt;'],
  ['Emoji 👩‍💻 and café', 'Emoji 👩‍💻 and café'],
])('escapes every original character once', (text, html) => {
  expect(escapeHtml(text)).toBe(html);
});

it('keeps class filtering and Tailwind conflict resolution', () => {
  expect(cleanClass('p-2', undefined, 'p-4', false, true, 3, null, ['p-8'], { class: 'p-10' })).toBe('p-4');
  expect(cleanClass('text-red-500', '', 'font-bold')).toBe('text-red-500 font-bold');
});

it('keeps icon overrides, disabled icons and fallback semantics', () => {
  const icons = { primary: 'base' };
  const override = { path: 'custom' };
  expect(resolveIcon({ icons, color: 'primary', override, fallback: 'fallback' })).toBe(override);
  expect(resolveIcon({ icons, color: 'primary', override: false, fallback: 'fallback' })).toBeUndefined();
  expect(resolveIcon({ icons, color: 'primary', fallback: 'fallback' })).toBe('base');
  expect(resolveIcon({ icons, color: 'secondary', fallback: 'fallback' })).toBe('fallback');
  expect(isIconLike('')).toBe(true);
  expect(isIconLike({ path: '' })).toBe(true);
  expect(isIconLike({})).toBe(false);
  expect(isIconLike(null)).toBe(false);
});

it('keeps array identity, falsy choices and monotonic generated identifiers', () => {
  const items = ['one'];
  expect(asArray(items)).toBe(items);
  expect(asArray('one')).toEqual(['one']);
  expect(asArray(false)).toEqual([]);
  const first = generateId();
  const second = generateId();
  expect(first).toMatch(/^ui-id-\d+$/);
  expect(Number(second.slice(6))).toBe(Number(first.slice(6)) + 1);
});
