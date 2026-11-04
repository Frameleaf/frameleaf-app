import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '$i18n/en.json';
import SettingsSkeleton from './SettingsSkeleton.svelte';

beforeAll(() => addMessages('dev', en));

it("shows the settings page's shape while it opens, named for screen readers", () => {
  const { container } = render(SettingsSkeleton);
  expect(screen.getByRole('status', { name: 'Opening settings' })).toBeInTheDocument();
  // the rail's links and the page's heading, lead and two cards
  expect(container.querySelector('.rail')?.querySelectorAll(':scope > *').length).toBeGreaterThan(8);
  expect(container.querySelector('.page')).not.toBeNull();
});
