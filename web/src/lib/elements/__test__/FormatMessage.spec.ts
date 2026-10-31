import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { init, locale, register, waitLocale, type Translations } from 'svelte-i18n';
import { describe, vi } from 'vitest';
import FormatMessage from '$lib/elements/FormatMessage.svelte';
import FormatTagB from '$lib/elements/__test__/FormatTagB.svelte';

const getSanitizedHTML = (container: HTMLElement) => container.getHTML().replaceAll('<!---->', '');

const { constructors } = vi.hoisted(() => ({ constructors: vi.fn() }));
vi.mock('intl-messageformat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('intl-messageformat')>();
  return {
    ...actual,
    IntlMessageFormat: new Proxy(actual.IntlMessageFormat, {
      construct(target, args, newTarget) {
        constructors();
        return Reflect.construct(target, args, newTarget);
      },
    }),
  };
});

describe('FormatMessage component', () => {
  beforeAll(async () => {
    register('fr', () => Promise.resolve({ hello: 'Bonjour {name}' }));
    register('en', () =>
      Promise.resolve({
        hello: 'Hello {name}',
        html: 'Hello <b>{name}</b>',
        plural: 'You have <b>{count, plural, one {# item} other {# items}}</b>',
        xss: '<image/src/onerror=prompt(8)>',
        plural_with_html: 'You have {count, plural, other {<b>#</b> items}}',
        select_with_html: 'Item is {status, select, other {<b>disabled</b>}}',
        ordinal_with_html: '{count, selectordinal, other {<b>#th</b>}} item',
        plural_with_name: '{count, plural, one {<b>{name}</b> has # item} other {<b>{name}</b> has # items}}',
      }),
    );

    await init({ fallbackLocale: 'en' });
    await waitLocale('en');
  });

  it('formats a plain text message', () => {
    render(FormatMessage, {
      key: 'hello' as Translations,
      values: { name: 'test' },
    });
    expect(screen.getByText('Hello test')).toBeInTheDocument();
  });

  it('reuses compiled formatting steps when only interpolation values change', async () => {
    const { rerender } = render(FormatMessage, { key: 'hello' as Translations, values: { name: 'first' } });
    constructors.mockClear();
    await rerender({ key: 'hello' as Translations, values: { name: 'second' } });
    expect(screen.getByText('Hello second')).toBeInTheDocument();
    expect(constructors).not.toHaveBeenCalled();
  });

  it('recompiles when the message key changes', async () => {
    const { container, rerender } = render(FormatTagB, { key: 'hello' as Translations, values: { name: 'first' } });
    await rerender({ key: 'html' as Translations, values: { name: 'second' } });
    expect(getSanitizedHTML(container)).toBe('Hello <strong>second</strong>');
  });

  it('recompiles when the active locale changes', async () => {
    render(FormatMessage, { key: 'hello' as Translations, values: { name: 'test' } });
    try {
      await locale.set('fr');
      await waitLocale('fr');
      await tick();
      expect(screen.getByText('Bonjour test')).toBeInTheDocument();
    } finally {
      await locale.set('en');
      await waitLocale('en');
    }
  });

  it('recovers after missing interpolation values become available', async () => {
    const { rerender } = render(FormatMessage, { key: 'hello' as Translations, values: {} });
    expect(screen.getByText('Hello {name}')).toBeInTheDocument();
    await rerender({ key: 'hello' as Translations, values: { name: 'recovered' } });
    expect(screen.getByText('Hello recovered')).toBeInTheDocument();
  });

  it('keeps interpolation markup as text inside a tag', () => {
    const { container } = render(FormatTagB, { key: 'html' as Translations, values: { name: '<b>literal</b>&' } });
    expect(getSanitizedHTML(container)).toBe('Hello <strong>&lt;b&gt;literal&lt;/b&gt;&amp;</strong>');
  });

  it('uses current plural values and snippet contents on each update', async () => {
    const { container, rerender } = render(FormatTagB, { key: 'plural' as Translations, values: { count: 1 } });
    await rerender({ key: 'plural' as Translations, values: { count: 5 } });
    expect(getSanitizedHTML(container)).toBe('You have <strong>5 items</strong>');
  });

  it('throws an error when locale is empty', async () => {
    await locale.set(undefined);
    expect(() => render(FormatMessage, { key: '' as Translations })).toThrow();
    await locale.set('en');
  });

  it('shows raw message when value is empty', () => {
    render(FormatMessage, {
      key: 'hello' as Translations,
    });
    expect(screen.getByText('Hello {name}')).toBeInTheDocument();
  });

  it('shows message when slot is empty', () => {
    render(FormatMessage, {
      key: 'html' as Translations,
      values: { name: 'test' },
    });
    expect(screen.getByText('Hello test')).toBeInTheDocument();
  });

  it('renders a message with html', () => {
    const { container } = render(FormatTagB, {
      key: 'html' as Translations,
      values: { name: 'test' },
    });
    expect(getSanitizedHTML(container)).toBe('Hello <strong>test</strong>');
  });

  it('renders a message with html and plural', () => {
    const { container } = render(FormatTagB, {
      key: 'plural' as Translations,
      values: { count: 1 },
    });
    expect(getSanitizedHTML(container)).toBe('You have <strong>1 item</strong>');
  });

  it('protects against XSS injection', () => {
    render(FormatMessage, {
      key: 'xss' as Translations,
    });
    expect(screen.getByText('<image/src/onerror=prompt(8)>')).toBeInTheDocument();
  });

  it('displays the message key when not found', () => {
    render(FormatMessage, { key: 'invalid.key' as Translations });
    expect(screen.getByText('invalid.key')).toBeInTheDocument();
  });

  it('supports html tags inside plurals', () => {
    const { container } = render(FormatTagB, {
      key: 'plural_with_html' as Translations,
      values: { count: 10 },
    });
    expect(getSanitizedHTML(container)).toBe('You have <strong>10</strong> items');
  });

  it('supports html tags inside select', () => {
    const { container } = render(FormatTagB, {
      key: 'select_with_html' as Translations,
      values: { status: true },
    });
    expect(getSanitizedHTML(container)).toBe('Item is <strong>disabled</strong>');
  });

  it('keeps caller text inside a plural branch as text, never as markup or message syntax', () => {
    const { container } = render(FormatTagB, {
      key: 'plural_with_name' as Translations,
      values: { count: 2, name: '<b>x</b> {oops' },
    });
    expect(getSanitizedHTML(container)).toBe('<strong>&lt;b&gt;x&lt;/b&gt; {oops</strong> has 2 items');
  });

  it('supports html tags inside selectordinal', () => {
    const { container } = render(FormatTagB, {
      key: 'ordinal_with_html' as Translations,
      values: { count: 4 },
    });
    expect(getSanitizedHTML(container)).toBe('<strong>4th</strong> item');
  });
});
