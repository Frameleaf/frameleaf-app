import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import FilterChip from './FilterChip.svelte';
import PersonAvatar from './PersonAvatar.svelte';
import Status from './Status.svelte';

vi.mock('$lib/utils', () => ({
  getPeopleThumbnailUrl: (person: { id: string }) => `/api/people/${person.id}/thumbnail`,
}));
vi.mock('$lib/components/assets/thumbnail/ImageThumbnail.svelte', async () => ({
  default: (await import('$lib/../test-data/frameleaf/TestImage.svelte')).default,
}));

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
    expect(container.innerHTML).not.toContain('person-1');
    expect(container.innerHTML).not.toContain('Private name');
  });

  it('announces status without relying on color', () => {
    render(Status, { message: 'Upload paused' });
    expect(screen.getByRole('status').textContent).toBe('Upload paused');
  });
});

// Native dialog focus trapping/escape is exercised in the browser fixture;
// happy-dom verifies the bindable state and invoker restoration contract.
it('opens modal and restores focus to its invoker when closed', async () => {
  const { default: DialogHarness } = await import('$lib/../test-data/frameleaf/DialogHarness.svelte');
  render(DialogHarness);
  const opener = screen.getByRole('button', { name: 'Open details' });
  opener.focus();
  await fireEvent.click(opener);
  expect(screen.getByRole('dialog').hasAttribute('open')).toBe(true);
  await fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
  expect(document.activeElement).toBe(opener);
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('keeps nested picker themes independent and disables all picker controls', async () => {
  vi.stubGlobal('visualViewport', null);
  const { default: PickerHarness } = await import('$lib/../test-data/frameleaf/PickerHarness.svelte');
  const { rerender } = render(PickerHarness, { theme: 'dark' });
  const outer = screen.getByRole('combobox', { name: 'Outer camera' });
  const nested = screen.getByRole('combobox', { name: 'Nested camera' });
  expect(outer.closest('.frameleaf')?.getAttribute('data-theme')).toBe('dark');
  expect(nested.closest('.frameleaf')?.getAttribute('data-theme')).toBe('light');
  await fireEvent.focus(outer);
  expect(screen.getAllByRole('option').map((option) => option.textContent?.trim())).toEqual([
    'Camera A (12)',
    'Camera B (8)',
  ]);
  await fireEvent.click(screen.getByRole('option', { name: 'Camera A (12)' }));
  await rerender({ theme: 'light', disabled: true });
  expect(outer.closest('.frameleaf')?.getAttribute('data-theme')).toBe('light');
  expect(nested.closest('.frameleaf')?.getAttribute('data-theme')).toBe('dark');
  expect(outer.matches(':disabled')).toBe(true);
  expect(screen.getByRole('button', { name: 'clear_value' }).closest('fieldset')?.disabled).toBe(true);
});
