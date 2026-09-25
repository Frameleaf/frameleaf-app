import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
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

it('closes on Escape (the dialog cancel event) and returns focus to its invoker (FL-29)', async () => {
  const { default: DialogHarness } = await import('$lib/../test-data/frameleaf/DialogHarness.svelte');
  render(DialogHarness);
  const opener = screen.getByRole('button', { name: 'Open details' });
  opener.focus();
  await fireEvent.click(opener);
  const dialog = screen.getByRole('dialog', { name: 'Details' });
  const cancel = new Event('cancel', { cancelable: true });
  dialog.dispatchEvent(cancel);
  await tick();
  // the browser's own close is replaced by the dialog's, so a guarded caller can keep it open
  expect(cancel.defaultPrevented).toBe(true);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(opener);
});

it('draws the prototype title bar and pins an actions footer outside the scrolling body', async () => {
  const { default: DialogHarness } = await import('$lib/../test-data/frameleaf/DialogHarness.svelte');
  render(DialogHarness, { withActions: true, wide: true });
  await fireEvent.click(screen.getByRole('button', { name: 'Open details' }));
  const dialog = screen.getByRole('dialog', { name: 'Details' });
  expect(dialog.classList).toContain('dialog');
  expect(dialog.classList).toContain('wide');
  expect(dialog.classList).toContain('with-actions');
  const close = screen.getByRole('button', { name: 'Close details' });
  // An icon close button: the label is the accessible name, the glyph is hidden.
  expect(close.closest('.dialog-title')).not.toBeNull();
  expect(close.textContent?.trim()).toBe('');
  expect(close.querySelector(':scope [aria-hidden="true"] svg')).not.toBeNull();
  const save = screen.getByRole('button', { name: 'Save' });
  expect(save.closest('.dialog-actions')).not.toBeNull();
  expect(screen.getByRole('textbox', { name: 'Name' }).closest('.dialog-body')).not.toBeNull();
  // The prototype's initial-focus contract.
  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Place' }));
  await fireEvent.click(save);
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('keeps the plain body layout when a caller passes no actions', async () => {
  const { default: DialogHarness } = await import('$lib/../test-data/frameleaf/DialogHarness.svelte');
  render(DialogHarness);
  await fireEvent.click(screen.getByRole('button', { name: 'Open details' }));
  const dialog = screen.getByRole('dialog', { name: 'Details' });
  expect(dialog.classList).not.toContain('with-actions');
  expect(dialog.classList).not.toContain('wide');
  expect(dialog.querySelector('.dialog-body, .dialog-actions')).toBeNull();
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
  const fade = vi.spyOn(transitions, 'fade');
  try {
    render(PickerHarness, { props: { theme: 'dark' }, intro: true });
    // The listbox flies in, or crossfades under Reduce Motion ($lib/frameleaf/motion.ts).
    if (reducedMotion) {
      await waitFor(() => expect(fade).toHaveBeenCalled());
      expect(fly).not.toHaveBeenCalled();
      expect(fade.mock.calls.every(([, options]) => options?.duration === 150)).toBe(true);
    } else {
      await waitFor(() => expect(fly).toHaveBeenCalled());
      expect(fly.mock.calls.every(([, options]) => options?.duration === 250)).toBe(true);
    }
    const input = screen.getByRole('combobox', { name: 'Outer camera' });
    await fireEvent.focus(input);
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect((input as HTMLInputElement).value).toBe('Camera A (12)');
  } finally {
    fly.mockRestore();
    fade.mockRestore();
    preference.mockRestore();
  }
});

const menuHarness = async () => (await import('$lib/../test-data/frameleaf/MenuHarness.svelte')).default;
const controlsHarness = async () => (await import('$lib/../test-data/frameleaf/ControlsHarness.svelte')).default;
const activeText = () => document.activeElement?.textContent?.trim();

describe('Frameleaf menu', () => {
  it('opens from the keyboard, roves focus and activates a command', async () => {
    const onSelect = vi.fn();
    render(await menuHarness(), { onSelect });
    const trigger = screen.getByRole('button', { name: 'Filter' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('menu')).toBeNull();

    trigger.focus();
    await fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const menu = screen.getByRole('menu', { name: 'Filter' });
    expect(trigger.getAttribute('aria-controls')).toBe(menu.id);
    // The first item takes focus, so the menu is usable without a pointer.
    expect(activeText()).toBe('People');

    await fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(activeText()).toBe('Date');
    // The last command is the harness's keep-open "More…" entry (FL-38).
    await fireEvent.keyDown(menu, { key: 'End' });
    expect(activeText()).toBe('More…');
    // Wrapping keeps both ends reachable from either direction.
    await fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(activeText()).toBe('People');
    await fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(activeText()).toBe('More…');
    await fireEvent.keyDown(menu, { key: 'Home' });
    expect(activeText()).toBe('People');

    await fireEvent.click(screen.getByRole('menuitem', { name: 'Date' }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith('date');
    // Activating a command closes the menu and hands focus back to the trigger.
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('opens on the last command with ArrowUp and returns focus on Escape', async () => {
    render(await menuHarness(), {});
    const trigger = screen.getByRole('button', { name: 'Filter' });
    trigger.focus();
    await fireEvent.keyDown(trigger, { key: 'ArrowUp' });
    expect(activeText()).toBe('More…');

    await fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('ignores a disabled command and leaves the menu open', async () => {
    const onSelect = vi.fn();
    render(await menuHarness(), { onSelect });
    await fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const places = screen.getByRole('menuitem', { name: 'Places' });
    // aria-disabled keeps the item focusable, so the guard has to live in the handlers.
    expect(places.getAttribute('aria-disabled')).toBe('true');
    await fireEvent.click(places);
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  it('reports a checkable command through aria-checked rather than colour', async () => {
    const Harness = await menuHarness();
    render(Harness, {});
    await fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    expect(screen.getByRole('menuitemcheckbox', { name: 'Hidden people' }).getAttribute('aria-checked')).toBe('false');
    await fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Hidden people' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    expect(screen.getByRole('menuitemcheckbox', { name: 'Hidden people' }).getAttribute('aria-checked')).toBe('true');
  });

  it('closes when a pointer press lands outside it', async () => {
    render(await menuHarness(), {});
    await fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    expect(screen.getByRole('menu')).toBeTruthy();
    await fireEvent.pointerDown(screen.getByRole('button', { name: 'After menu' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('keeps a keepOpen item open so it can swap in a follow-up view (FL-38)', async () => {
    const onSelect = vi.fn();
    render(await menuHarness(), { onSelect });
    await fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    expect(screen.getByRole('menuitem', { name: 'People' })).toBeTruthy();

    await fireEvent.click(screen.getByRole('menuitem', { name: 'More…' }));
    expect(onSelect).toHaveBeenCalledWith('more');
    // The popup itself stays open and its content swapped, rather than closing.
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'People' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Detail view' })).toBeTruthy();

    // An ordinary item inside that follow-up view still closes the popup as normal.
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Detail view' }));
    expect(onSelect).toHaveBeenCalledWith('detail-choice');
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('Frameleaf controls', () => {
  it('names an icon-only button and reports its pressed state', async () => {
    render(await controlsHarness(), {});
    const favorite = screen.getByRole('button', { name: 'Favorite' });
    expect(favorite.getAttribute('aria-pressed')).toBe('false');
    // The icon is hidden from assistive technology, so the label is the only name.
    expect(favorite.querySelector('span')?.getAttribute('aria-hidden')).toBe('true');
    await fireEvent.click(favorite);
    expect(favorite.getAttribute('aria-pressed')).toBe('true');
  });

  it('announces a badge by its meaning, never by its colour or bare count', async () => {
    const { container } = render(await controlsHarness(), {});
    const badge = container.querySelector('.badge');
    expect(badge?.querySelector('[aria-hidden="true"]')?.textContent).toBe('3');
    expect(badge?.querySelector('.sr-only')?.textContent).toBe('3 filters active');
  });

  it('keeps exactly one segment pressed and reports the change', async () => {
    const onAction = vi.fn();
    render(await controlsHarness(), { onAction });
    const group = screen.getByRole('group', { name: 'Media type' });
    const pressed = () =>
      [...group.querySelectorAll('button')].filter((segment) => segment.getAttribute('aria-pressed') === 'true');
    expect(pressed()).toHaveLength(1);
    expect(pressed()[0]).toBe(screen.getByRole('button', { name: 'All' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Photos' }));
    expect(pressed()).toHaveLength(1);
    expect(pressed()[0]).toBe(screen.getByRole('button', { name: 'Photos' }));
    expect(onAction).toHaveBeenCalledWith('media:photo');
  });

  it('operates the switch by role and states on and off in text', async () => {
    const onAction = vi.fn();
    render(await controlsHarness(), { onAction });
    const toggle = screen.getByRole('switch', { name: 'Include archived' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.textContent?.trim()).toBe('Off');
    await fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.textContent?.trim()).toBe('On');
    expect(onAction).toHaveBeenCalledWith('archived:true');
  });

  it('disables controls from one caller flag while keeping their state legible', async () => {
    render(await controlsHarness(), { disabled: true });
    const toggle = screen.getByRole('switch', { name: 'Include archived' });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    // A disabled control still has to say which state it is in.
    expect(toggle.textContent?.trim()).toBe('Off');
    expect((screen.getByRole('button', { name: 'Create album' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Videos' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('removes a chip through a control that names what it removes', async () => {
    render(await controlsHarness(), {});
    await fireEvent.click(screen.getByRole('button', { name: 'Remove year 2026' }));
    expect(screen.queryByRole('button', { name: 'Remove year 2026' })).toBeNull();
  });
});
