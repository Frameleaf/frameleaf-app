import { AssetDevelopMaskKind } from '@immich/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { createMask } from '$lib/frameleaf/photo-tools';
import MaskOverlay from './MaskOverlay.svelte';

/** Mask handles on the stage (FL-64): placed by pointer or, as here, by the arrow keys. */
describe('MaskOverlay', () => {
  it('moves and resizes a radial mask from the keyboard', async () => {
    const mask = createMask(AssetDevelopMaskKind.Radial);
    const onCommit = vi.fn();
    render(MaskOverlay, { mask, onPreview: vi.fn(), onCommit });

    await fireEvent.keyDown(screen.getByRole('button', { name: 'frameleaf_editor_mask_move' }), { key: 'ArrowRight' });
    expect(onCommit).toHaveBeenLastCalledWith(expect.objectContaining({ x: 0.51, y: 0.5 }));

    await fireEvent.keyDown(screen.getByRole('button', { name: 'frameleaf_editor_mask_width' }), {
      key: 'ArrowLeft',
      shiftKey: true,
    });
    expect(onCommit).toHaveBeenLastCalledWith(expect.objectContaining({ radiusX: 0.2 }));
  });

  it('moves the ends of a linear mask and never lets them meet', async () => {
    const mask = { ...createMask(AssetDevelopMaskKind.Linear), x: 0.5, y: 0.5, endX: 0.5, endY: 0.51 };
    const onCommit = vi.fn();
    render(MaskOverlay, { mask, onPreview: vi.fn(), onCommit });

    await fireEvent.keyDown(screen.getByRole('button', { name: 'frameleaf_editor_mask_end' }), { key: 'ArrowUp' });
    expect(onCommit).not.toHaveBeenCalled();
    await fireEvent.keyDown(screen.getByRole('button', { name: 'frameleaf_editor_mask_start' }), { key: 'ArrowUp' });
    expect(onCommit).toHaveBeenLastCalledWith(expect.objectContaining({ x: 0.5, y: 0.49 }));
  });
});
