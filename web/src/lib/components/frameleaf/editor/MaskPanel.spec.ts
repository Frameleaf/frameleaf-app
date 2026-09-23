import { AssetDevelopMaskKind } from '@immich/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { createMask, MAX_MASKS, type EditorMask } from '$lib/frameleaf/photo-tools';
import MaskPanel from './MaskPanel.svelte';

vi.mock('@immich/ui', async () => {
  const actual = await vi.importActual<typeof import('@immich/ui')>('@immich/ui');
  const { default: Icon } = await import('@test-data/components/MockIcon.svelte');
  return { ...actual, Icon };
});

/** MaskPanel (FL-64). The test i18n setup renders keys, so assertions match on `frameleaf_editor_*`. */
describe('MaskPanel', () => {
  const last = (onChange: ReturnType<typeof vi.fn>) => onChange.mock.calls.at(-1)?.[0] as EditorMask[];

  it('adds radial and linear masks and says there are none yet', async () => {
    const onChange = vi.fn();
    render(MaskPanel, { masks: [], onChange });
    expect(screen.getByText('frameleaf_editor_masks_empty')).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_mask_add_radial' }));
    expect(last(onChange)).toEqual([expect.objectContaining({ kind: AssetDevelopMaskKind.Radial })]);

    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_mask_add_linear' }));
    expect(last(onChange)).toEqual([expect.objectContaining({ kind: AssetDevelopMaskKind.Linear })]);
  });

  it('edits the selected mask: its light and color controls, amount, feather and invert', async () => {
    const mask = createMask(AssetDevelopMaskKind.Radial);
    const onChange = vi.fn();
    render(MaskPanel, { masks: [mask], selectedId: mask.id, onChange });

    expect(screen.getByRole('radio', { name: /frameleaf_editor_mask_number/ })).toHaveAttribute('aria-checked', 'true');
    await fireEvent.input(screen.getByRole('slider', { name: 'frameleaf_editor_param_exposure' }), {
      target: { value: '-0.5' },
    });
    expect(last(onChange)[0].adjustments).toMatchObject({ exposure: -0.5, contrast: 0 });

    await fireEvent.input(screen.getByRole('slider', { name: 'frameleaf_editor_mask_feather' }), {
      target: { value: '20' },
    });
    expect(last(onChange)[0].feather).toBe(20);
    await fireEvent.input(screen.getByRole('slider', { name: 'frameleaf_editor_mask_amount' }), {
      target: { value: '40' },
    });
    expect(last(onChange)[0].amount).toBe(40);

    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_mask_invert' }));
    expect(last(onChange)[0].invert).toBe(true);
    // Spatial controls stay global.
    expect(screen.queryByRole('slider', { name: 'frameleaf_editor_param_clarity' })).toBeNull();
  });

  it('hides a linear mask without a feather control, turns masks off and deletes them', async () => {
    const mask = createMask(AssetDevelopMaskKind.Linear);
    const onChange = vi.fn();
    render(MaskPanel, { masks: [mask], selectedId: mask.id, onChange });
    expect(screen.queryByRole('slider', { name: 'frameleaf_editor_mask_feather' })).toBeNull();

    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_mask_hide' }));
    expect(last(onChange)[0].enabled).toBe(false);

    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_mask_delete' }));
    expect(last(onChange)).toEqual([]);
  });

  it(`stops adding at ${MAX_MASKS} masks`, () => {
    const masks: EditorMask[] = [];
    for (let i = 0; i < MAX_MASKS; i += 1) {
      masks.push(createMask(AssetDevelopMaskKind.Radial, masks));
    }
    render(MaskPanel, { masks, onChange: vi.fn() });
    expect(screen.getByRole('button', { name: 'frameleaf_editor_mask_add_radial' })).toBeDisabled();
    expect(screen.getByText('frameleaf_editor_masks_limit')).toBeInTheDocument();
  });
});
