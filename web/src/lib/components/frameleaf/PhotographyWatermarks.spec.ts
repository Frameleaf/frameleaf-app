import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '$i18n/en.json';
import { loadBrand, type Brand } from '$lib/frameleaf/photography/api';
import PhotographyWatermarks from './PhotographyWatermarks.svelte';

vi.mock('$lib/frameleaf/photography/api', () => ({ loadBrand: vi.fn(), saveBrand: vi.fn() }));
beforeAll(() => addMessages('dev', en));

it('names what each default does instead of showing blank choices before any preset exists', async () => {
  vi.mocked(loadBrand).mockResolvedValue({
    revision: 'loaded',
    logoUnavailable: false,
    // a studio that has never saved a preset: the default ids are not there at all
    brand: { name: 'North Studio' } as Brand,
  });
  render(PhotographyWatermarks);
  const exports = await screen.findByRole('combobox', { name: 'Final exports' });
  expect(exports).toHaveDisplayValue('No watermark');
  expect(exports).toBeDisabled();
  for (const name of ['Edited web previews', 'Selection proofs']) {
    expect(screen.getByRole('combobox', { name })).toHaveDisplayValue('Your branding mark');
  }
});
