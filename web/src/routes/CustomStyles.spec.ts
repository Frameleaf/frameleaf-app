import { render } from '@testing-library/svelte';
import type { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import CustomStyles from './CustomStyles.svelte';

const stylesheet = () => document.head.querySelector('link[href="/custom.css"]');

beforeAll(() => {
  (globalThis as unknown as Window).happyDOM.settings.disableCSSFileLoading = true;
  (globalThis as unknown as Window).happyDOM.settings.handleDisabledFileLoadingAsSuccess = true;
});

it.each(['/user-settings', '/user-settings/', '/admin', '/admin/system-settings', '/admin/users'])(
  'keeps custom CSS out of %s on initial render',
  (pathname) => {
    render(CustomStyles, { pathname });
    expect(stylesheet()).toBeNull();
  },
);

it('removes custom CSS when entering settings and restores it when leaving', async () => {
  const view = render(CustomStyles, { pathname: '/photos' });
  expect(stylesheet()).toHaveAttribute('rel', 'stylesheet');

  await view.rerender({ pathname: '/user-settings' });
  expect(stylesheet()).toBeNull();

  await view.rerender({ pathname: '/albums' });
  expect(stylesheet()).toHaveAttribute('rel', 'stylesheet');

  view.unmount();
  expect(stylesheet()).toBeNull();
});

it.each(['/user-settings-archive', '/administrator', '/auth/login'])('keeps custom CSS on %s', (pathname) => {
  render(CustomStyles, { pathname });
  expect(stylesheet()).toHaveAttribute('rel', 'stylesheet');
});

it('does not load custom CSS before the route can protect settings', () => {
  expect(readFileSync('src/app.html', 'utf8')).not.toContain('href="/custom.css"');
});
