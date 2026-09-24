import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { get } from 'svelte/store';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SlideshowTransition } from '$lib/frameleaf/slideshow-transitions';
import { SlideshowLook, SlideshowMetadataOverlayMode, slideshowStore } from '$lib/stores/slideshow.store';
import en from '../../../../../i18n/en.json';
import SlideshowSettingsDialog from './SlideshowSettingsDialog.svelte';

describe('SlideshowSettingsDialog (FL-36)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    HTMLDialogElement.prototype.showModal ??= vi.fn(function (this: HTMLDialogElement) {
      this.open = true;
    });
    HTMLDialogElement.prototype.close ??= vi.fn(function (this: HTMLDialogElement) {
      this.open = false;
    });
    slideshowStore.slideshowTransition.set(SlideshowTransition.Fade);
    slideshowStore.slideshowLook.set(SlideshowLook.Contain);
    slideshowStore.slideshowShowMetadataOverlay.set(false);
    slideshowStore.slideshowDelay.set(5);
  });

  it('offers the five transitions with Fade marked as the default', () => {
    render(SlideshowSettingsDialog, { open: true });

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
    render(SlideshowSettingsDialog, { open: true });

    await fireEvent.change(screen.getByLabelText('Transition'), { target: { value: 'memories' } });
    expect(get(slideshowStore.slideshowTransition)).toBe(SlideshowTransition.Memories);
  });

  it('maps the caption choice onto the overlay settings', async () => {
    render(SlideshowSettingsDialog, { open: true });

    const caption = screen.getByLabelText('Caption') as HTMLSelectElement;
    expect(caption.value).toBe('off');
    await fireEvent.change(caption, { target: { value: 'description' } });
    expect(get(slideshowStore.slideshowShowMetadataOverlay)).toBe(true);
    expect(get(slideshowStore.slideshowMetadataOverlayMode)).toBe(SlideshowMetadataOverlayMode.DescriptionOnly);
    await fireEvent.change(caption, { target: { value: 'off' } });
    expect(get(slideshowStore.slideshowShowMetadataOverlay)).toBe(false);
  });

  it('uses the template copy for duration and fit', async () => {
    render(SlideshowSettingsDialog, { open: true });

    const duration = screen.getByLabelText('Photo duration') as HTMLSelectElement;
    expect([...duration.options].map((option) => option.value)).toEqual(['2', '3', '5', '10', '15', '30']);
    await fireEvent.change(duration, { target: { value: '10' } });
    expect(get(slideshowStore.slideshowDelay)).toBe(10);
    expect(screen.getByRole('option', { name: 'Fit entire photo' })).toBeInTheDocument();
    expect(screen.getByText('Videos play to their end. Photos follow the duration above.')).toBeInTheDocument();
  });
});
