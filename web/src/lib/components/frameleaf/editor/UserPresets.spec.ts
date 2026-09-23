import { AssetDevelopPreset, createDevelopPreset, getDevelopPresets, updateDevelopPreset } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { presetSettingsFrom } from '$lib/frameleaf/photo-tools';
import UserPresets from './UserPresets.svelte';

vi.mock('@immich/sdk', async () => {
  const sdk = await vi.importActual<typeof import('@immich/sdk')>('@immich/sdk');
  return {
    ...sdk,
    getDevelopPresets: vi.fn(),
    createDevelopPreset: vi.fn(),
    updateDevelopPreset: vi.fn(),
    deleteDevelopPreset: vi.fn(),
  };
});

vi.mock('@immich/ui', async () => {
  const actual = await vi.importActual<typeof import('@immich/ui')>('@immich/ui');
  const { default: Icon } = await import('@test-data/components/MockIcon.svelte');
  return {
    ...actual,
    Icon,
    modalManager: { showDialog: vi.fn() },
    toastManager: { primary: vi.fn(), danger: vi.fn() },
  };
});

/** "Your presets" (FL-64): save the current settings, then reapply them to another photo. */
describe('UserPresets', () => {
  const warm = presetSettingsFrom({ temperature: 30, preset: AssetDevelopPreset.Warm });
  const stored = {
    id: '5b1f0c3e-7a2d-4c11-8e0f-2b3c4d5e6f70',
    name: 'Golden hour',
    settings: warm,
    createdAt: '2026-09-23T08:00:00.000Z',
    updatedAt: '2026-09-23T08:00:00.000Z',
  };

  afterEach(() => vi.clearAllMocks());

  it('saves the current settings under a name', async () => {
    vi.mocked(getDevelopPresets).mockResolvedValue([]);
    vi.mocked(createDevelopPreset).mockResolvedValue(stored);
    render(UserPresets, { current: warm, onApply: vi.fn() });
    await waitFor(() => expect(screen.getByText('frameleaf_editor_your_presets_empty')).toBeInTheDocument());

    await fireEvent.input(screen.getByLabelText('frameleaf_editor_preset_name'), {
      target: { value: ' Golden hour ' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_preset_save' }));

    await waitFor(() =>
      expect(createDevelopPreset).toHaveBeenCalledWith({
        developPresetCreateDto: { name: 'Golden hour', settings: warm },
      }),
    );
    expect(await screen.findByRole('button', { name: 'Golden hour' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('reapplies a saved preset to the draft and shows which one is applied', async () => {
    vi.mocked(getDevelopPresets).mockResolvedValue([stored]);
    const onApply = vi.fn();
    render(UserPresets, { current: presetSettingsFrom({}), onApply });

    const button = await screen.findByRole('button', { name: 'Golden hour' });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    await fireEvent.click(button);
    expect(onApply).toHaveBeenCalledWith(warm);
  });

  it('replaces a preset with the current settings', async () => {
    vi.mocked(getDevelopPresets).mockResolvedValue([stored]);
    const cooler = presetSettingsFrom({ temperature: -20 });
    vi.mocked(updateDevelopPreset).mockResolvedValue({ ...stored, settings: cooler });
    render(UserPresets, { current: cooler, onApply: vi.fn() });

    await fireEvent.click(await screen.findByRole('button', { name: 'frameleaf_editor_preset_update' }));
    await waitFor(() =>
      expect(updateDevelopPreset).toHaveBeenCalledWith({ id: stored.id, developPresetUpdateDto: { settings: cooler } }),
    );
  });

  it('shows why a save was refused', async () => {
    vi.mocked(getDevelopPresets).mockResolvedValue([]);
    vi.mocked(createDevelopPreset).mockRejectedValue(new Error('A preset with this name already exists'));
    render(UserPresets, { current: warm, onApply: vi.fn() });
    await fireEvent.input(screen.getByLabelText('frameleaf_editor_preset_name'), { target: { value: 'Golden hour' } });
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_preset_save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('frameleaf_editor_preset_save_error');
  });
});
