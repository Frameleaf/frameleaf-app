import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '$i18n/en.json';
import { loadBrand, saveBrand, type Brand } from '$lib/frameleaf/photography/api';
import { PhotographyError } from '$lib/frameleaf/photography/errors';
import PhotographyBranding from './PhotographyBranding.svelte';

const access = vi.hoisted(() => ({ changed: undefined as undefined | (() => void) }));
vi.mock('$lib/frameleaf/photography/api', () => ({
  loadBrand: vi.fn(),
  saveBrand: vi.fn(),
  loadLogos: vi.fn(),
  logoThumbnailUrl: (id: string) => `/protected/logo/${id}`,
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { user: { id: 'owner' }, authenticated: true } }));
vi.mock('$lib/frameleaf/library-access', () => ({
  onLibraryAccessChange: (fn: () => void) => {
    access.changed = fn;
    return () => {
      access.changed = undefined;
    };
  },
}));
const brand: Brand = {
  name: 'North Studio',
  tagline: 'Portraits',
  email: '',
  phone: '',
  logoInitials: 'NS',
  logoAssetId: null,
  color: '#577059',
  background: '#f5f3ed',
  textColor: '#263329',
  font: 'editorial',
  watermarkColor: '#ffffff',
  watermarkOpacity: 45,
  watermarkPosition: 'bottom-right',
  watermarkSize: 6,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadBrand).mockResolvedValue({ revision: 'loaded', brand, logoUnavailable: true });
});
beforeAll(() => addMessages('dev', en));
it('edits real loaded settings and reports success only after the server resolves', async () => {
  const onSaved = vi.fn();
  let resolveSave!: (value: Awaited<ReturnType<typeof saveBrand>>) => void;
  vi.mocked(saveBrand).mockImplementation(() => new Promise((resolve) => (resolveSave = resolve)));
  render(PhotographyBranding, { onSaved });
  const name = await screen.findByRole('textbox', { name: 'Studio name' });
  await fireEvent.input(name, { target: { value: 'Renamed studio' } });
  await fireEvent.click(screen.getByRole('button', { name: 'Subtle' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Save branding' }));
  await waitFor(() =>
    expect(saveBrand).toHaveBeenCalledWith(
      'loaded',
      expect.objectContaining({ name: 'Renamed studio', watermarkOpacity: 35, watermarkSize: 4 }),
    ),
  );
  expect(vi.mocked(saveBrand).mock.calls[0][1]).not.toHaveProperty('logoAssetId');
  expect(vi.mocked(saveBrand).mock.calls[0][1]).not.toHaveProperty('watermarkPresets');
  expect(onSaved).not.toHaveBeenCalled();
  resolveSave({ revision: 'persisted', brand: { ...brand, name: 'Renamed studio' }, logoUnavailable: true });
  await screen.findByText('Branding saved on your server');
  expect(onSaved).toHaveBeenCalledOnce();
});
it('surfaces a conflict without announcing a save and reloads the latest server revision', async () => {
  const onSaved = vi.fn();
  vi.mocked(saveBrand).mockRejectedValue(new PhotographyError('settings_changed', 409));
  render(PhotographyBranding, { onSaved });
  await screen.findByRole('textbox', { name: 'Studio name' });
  await fireEvent.click(screen.getByRole('button', { name: 'Save branding' }));
  await screen.findByRole('alert');
  expect(onSaved).not.toHaveBeenCalled();
  vi.mocked(loadBrand).mockResolvedValue({
    revision: 'latest',
    brand: { ...brand, name: 'Other window' },
    logoUnavailable: false,
  });
  await fireEvent.click(screen.getByRole('button', { name: 'Reload branding' }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Studio name' })).toHaveValue('Other window'));
});
it('clears private drafts immediately when library access changes', async () => {
  render(PhotographyBranding, { onSaved: vi.fn() });
  await screen.findByRole('textbox', { name: 'Studio name' });
  vi.mocked(loadBrand).mockImplementation(() => new Promise(() => {}));
  access.changed?.();
  await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Studio name' })).not.toBeInTheDocument());
  expect(screen.queryByText('North Studio')).not.toBeInTheDocument();
});
