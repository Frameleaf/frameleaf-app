import { StudioExportShape, StudioReframeShotType, StudioReframeSubject } from '@frameleaf/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { expect, it } from 'vitest';
import StudioExportReframe from './StudioExportReframe.svelte';

it('shows the actual centered vertical crop for a landscape delivery of a portrait source', async () => {
  render(StudioExportReframe, {
    shape: StudioExportShape.Landscape,
    size: { width: 1920, height: 1080 },
    framing: {
      revision: 3,
      width: 1080,
      height: 1920,
      shots: [
        {
          clipId: 'shot',
          type: StudioReframeShotType.Video,
          assetId: null,
          from: 0,
          durationInFrames: 120,
          subject: StudioReframeSubject.None,
          path: [{ t: 0.5, x: 0.5 }],
        },
      ],
    },
  });
  const box = screen.getByTestId('studio-reframe-box');
  expect(box).toHaveStyle({ width: '100%' });
  expect(parseFloat(box.style.top)).toBeGreaterThan(30);
  expect(box.style.top).toBe(box.style.bottom);
  const before = box.getAttribute('aria-valuenow');
  await fireEvent.keyDown(box, { key: 'ArrowRight' });
  expect(box.getAttribute('aria-valuenow')).toBe(before);
});
