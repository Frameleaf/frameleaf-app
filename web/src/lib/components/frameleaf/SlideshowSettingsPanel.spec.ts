import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { get } from 'svelte/store';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SlideshowTransition } from '$lib/frameleaf/slideshow-transitions';
import { SlideshowLook, SlideshowMetadataOverlayMode, slideshowStore } from '$lib/stores/slideshow.store';
import en from '../../../../../i18n/en.json';
import SlideshowSettingsPanel from './SlideshowSettingsPanel.svelte';

describe('SlideshowSettingsPanel (FL-36)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    slideshowStore.slideshowTransition.set(SlideshowTransition.Fade);
    slideshowStore.slideshowLook.set(SlideshowLook.Contain);
    slideshowStore.slideshowShowMetadataOverlay.set(false);
    slideshowStore.slideshowDelay.set(5);
  });

  it('offers the five transitions with Fade marked as the default', () => {
    render(SlideshowSettingsPanel, { onClose: vi.fn() });

    const transition = screen.getByLabelText('Transition') as HTMLSelectElement;
    expect([...transition.options].map((option) => option.text)).toEqual([
      'None',
      'Fade (default)',
      'Slide',
      'Ken Burns',
      'Memories',
    ]);
    expect(transition.value).toBe('fade');
  });

  it('applies a new transition at once', async () => {
    render(SlideshowSettingsPanel, { onClose: vi.fn() });

    await fireEvent.change(screen.getByLabelText('Transition'), { target: { value: 'memories' } });
    expect(get(slideshowStore.slideshowTransition)).toBe(SlideshowTransition.Memories);
  });

  it('maps the caption choice onto the overlay settings', async () => {
    render(SlideshowSettingsPanel, { onClose: vi.fn() });

    const caption = screen.getByLabelText('Caption') as HTMLSelectElement;
    expect(caption.value).toBe('off');
    await fireEvent.change(caption, { target: { value: 'description' } });
    expect(get(slideshowStore.slideshowShowMetadataOverlay)).toBe(true);
    expect(get(slideshowStore.slideshowMetadataOverlayMode)).toBe(SlideshowMetadataOverlayMode.DescriptionOnly);
    await fireEvent.change(caption, { target: { value: 'off' } });
    expect(get(slideshowStore.slideshowShowMetadataOverlay)).toBe(false);
  });

  it('uses the template copy for duration and fit', async () => {
    render(SlideshowSettingsPanel, { onClose: vi.fn() });

    const duration = screen.getByLabelText('Photo duration') as HTMLSelectElement;
    expect([...duration.options].map((option) => option.value)).toEqual(['2', '3', '5', '10', '15', '30']);
    await fireEvent.change(duration, { target: { value: '10' } });
    expect(get(slideshowStore.slideshowDelay)).toBe(10);
    expect(screen.getByRole('option', { name: 'Fit entire photo' })).toBeInTheDocument();
    expect(screen.getByText('Videos play to their end. Photos follow the duration above.')).toBeInTheDocument();
  });

  it('is a non-modal panel named Slideshow, closed by Escape or its close button', async () => {
    const onClose = vi.fn();
    render(SlideshowSettingsPanel, { onClose });

    const panel = screen.getByRole('region', { name: 'Slideshow' });
    expect(panel.tagName).toBe('SECTION');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(panel).toHaveClass('fl-continuous-corners');

    await fireEvent.keyDown(screen.getByLabelText('Transition'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    await fireEvent.click(screen.getByRole('button', { name: 'Close slideshow settings' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  // Source behaviour retained: production has always had the Autoplay preference.
  it('keeps the Autoplay preference reachable', async () => {
    slideshowStore.slideshowAutoplay.set(false);
    render(SlideshowSettingsPanel, { onClose: vi.fn() });

    const autoplay = screen.getByRole('switch', { name: 'Autoplay slideshow' });
    expect(autoplay).toHaveAttribute('aria-checked', 'false');
    await fireEvent.click(autoplay);
    expect(get(slideshowStore.slideshowAutoplay)).toBe(true);
  });

  // MediaViewer.jsx:499-502
  it('puts focus on Photo duration when it opens', () => {
    render(SlideshowSettingsPanel, { onClose: vi.fn() });
    expect(screen.getByLabelText('Photo duration')).toHaveFocus();
  });
});
