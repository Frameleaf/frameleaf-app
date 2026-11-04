import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '$i18n/en.json';
import { loadBrand, saveBrand, type Brand } from '$lib/frameleaf/photography/api';
import PhotographyWatermarks from './PhotographyWatermarks.svelte';

vi.mock('$lib/frameleaf/photography/api', async (original) => ({
  ...(await original<typeof import('$lib/frameleaf/photography/api')>()),
  loadBrand: vi.fn(),
  saveBrand: vi.fn(),
}));
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

it('designs the branding mark here, the one place for the watermark, and saves it with the presets', async () => {
  const brand = {
    name: 'North Studio',
    logoInitials: 'NS',
    font: 'editorial',
    watermarkColor: '#ffffff',
    watermarkOpacity: 45,
    watermarkPosition: 'bottom-right',
    watermarkSize: 6,
  } as Brand;
  vi.mocked(loadBrand).mockResolvedValue({ revision: 'loaded', logoUnavailable: false, brand });
  vi.mocked(saveBrand).mockResolvedValue({ revision: 'saved', logoUnavailable: false, brand });
  render(PhotographyWatermarks);
  await fireEvent.click(await screen.findByRole('button', { name: 'Subtle' }));
  expect(screen.getByRole('combobox', { name: 'Position' })).toHaveDisplayValue('Bottom right');
  await fireEvent.click(screen.getByRole('button', { name: 'Save watermark presets' }));
  await waitFor(() =>
    expect(saveBrand).toHaveBeenCalledWith(
      'loaded',
      expect.objectContaining({ watermarkOpacity: 35, watermarkSize: 4, watermarkPosition: 'bottom-right' }),
    ),
  );
});
