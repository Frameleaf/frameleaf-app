import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import * as transitions from 'svelte/transition';
import { describe, expect, it, vi } from 'vitest';
import PickerHarness from '$lib/../test-data/frameleaf/PickerHarness.svelte';
import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';
import FilterChip from './FilterChip.svelte';
import PersonAvatar from './PersonAvatar.svelte';
import Status from './Status.svelte';

vi.mock('$lib/utils', () => ({
  getPeopleThumbnailUrl: (person: { id: string }) => `/api/people/${person.id}/thumbnail`,
}));
vi.mock('$lib/components/assets/thumbnail/ImageThumbnail.svelte', async () => {
  const { default: TestImage } = await import('$lib/../test-data/frameleaf/TestImage.svelte');
  return { default: TestImage };
});

describe('Frameleaf primitives', () => {
  it('removes filters through a labelled button and preserves the caller callback', async () => {
    const onRemove = vi.fn();
    render(FilterChip, { label: '2026', removeLabel: 'Remove year 2026', onRemove });
    await fireEvent.click(screen.getByRole('button', { name: 'Remove year 2026' }));
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it('unmounts private face evidence when current access is withdrawn', async () => {
    const { rerender, container } = render(PersonAvatar, {
      person: { id: 'person-1', name: 'Private name', updatedAt: '2026-09-21' } as never,
    });
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/api/people/person-1/thumbnail');
    await rerender({ person: undefined });
    expect(container.querySelector('img')).toBeNull();
    expect(container.getHTML()).not.toContain('person-1');
    expect(container.getHTML()).not.toContain('Private name');
  });

  it('announces status without relying on color', () => {
    render(Status, { message: 'Upload paused' });
    expect(screen.getByRole('status').textContent).toBe('Upload paused');
  });
});

// Native dialog focus trapping/escape is exercised in the browser fixture;
// happy-dom verifies the bindable state and invoker restoration contract.
it.each([false, true])('restores its invoker even when opening does not focus it (%s)', async (focused) => {
  const { default: DialogHarness } = await import('$lib/../test-data/frameleaf/DialogHarness.svelte');
  render(DialogHarness);
  const opener = screen.getByRole('button', { name: 'Open details' });
  if (focused) {
    opener.focus();
  }
  await fireEvent.click(opener);
  expect(screen.getByRole('dialog').hasAttribute('open')).toBe(true);
  await fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
  expect(document.activeElement).toBe(opener);
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('keeps nested picker themes independent and disables all picker controls', async () => {
  vi.stubGlobal('visualViewport', null);
  const { rerender } = render(PickerHarness, { theme: 'dark' });
  const outer = screen.getByRole('combobox', { name: 'Outer camera' });
  const nested = screen.getByRole('combobox', { name: 'Nested camera' });
  expect(outer.closest<HTMLElement>('.frameleaf')?.dataset.theme).toBe('dark');
  expect(nested.closest<HTMLElement>('.frameleaf')?.dataset.theme).toBe('light');
  await fireEvent.focus(outer);
  expect(screen.getAllByRole('option').map((option) => option.textContent?.trim())).toEqual([
    'Camera A (12)',
    'Camera B (8)',
  ]);
  await fireEvent.click(screen.getByRole('option', { name: 'Camera A (12)' }));
  await rerender({ theme: 'light', disabled: true });
  expect(outer.closest<HTMLElement>('.frameleaf')?.dataset.theme).toBe('light');
  expect(nested.closest<HTMLElement>('.frameleaf')?.dataset.theme).toBe('dark');
  expect(outer.matches(':disabled')).toBe(true);
  expect(screen.getByRole('button', { name: 'clear_value' }).closest('fieldset')?.disabled).toBe(true);
});

it.each([false, true])('honors reduced motion (%s) when introducing a picker', async (reducedMotion) => {
  vi.stubGlobal('visualViewport', null);
  const preference = vi.spyOn(mediaQueryManager, 'reducedMotion', 'get').mockReturnValue(reducedMotion);
  const fly = vi.spyOn(transitions, 'fly');
  try {
    render(PickerHarness, { props: { theme: 'dark' }, intro: true });
    await waitFor(() => expect(fly).toHaveBeenCalled());
    expect(fly.mock.calls.every(([, options]) => options?.duration === (reducedMotion ? 0 : 250))).toBe(true);
    const input = screen.getByRole('combobox', { name: 'Outer camera' });
    await fireEvent.focus(input);
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect((input as HTMLInputElement).value).toBe('Camera A (12)');
  } finally {
    fly.mockRestore();
    preference.mockRestore();
  }
});
