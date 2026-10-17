import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { languageManager } from '$lib/managers/language-manager.svelte';
import MenuIsolationTest from './__test__/MenuIsolationTest.svelte';

const button = (name: string) => screen.getByRole('button', { name });
const menu = (name: string) => document.querySelector<HTMLElement>(`#${button(name).getAttribute('aria-controls')}`)!;
const option = (name: string) => screen.getByRole('menuitem', { name, hidden: true });

it('keeps hover selection and active descendants inside their owning menu', async () => {
  render(MenuIsolationTest);
  await fireEvent.click(button('First'));
  await fireEvent.mouseOver(option('First option'));
  expect(menu('First')).toHaveAttribute('aria-activedescendant', option('First option').id);
  expect(menu('Second')).toHaveAttribute('aria-activedescendant', '');
  await fireEvent.mouseLeave(option('First option'));
  expect(menu('First')).toHaveAttribute('aria-activedescendant', '');
});

it('clears only its own keyboard selection when a menu closes', async () => {
  render(MenuIsolationTest);
  await fireEvent.keyDown(button('First'), { key: 'ArrowDown' });
  await waitFor(() => expect(menu('First')).toHaveAttribute('aria-activedescendant', option('First option').id));
  await fireEvent.keyDown(button('Second'), { key: 'ArrowDown' });
  await waitFor(() => expect(menu('Second')).toHaveAttribute('aria-activedescendant', option('Second option').id));
  await fireEvent.keyDown(menu('First'), { key: 'Escape' });
  expect(button('First')).toHaveAttribute('aria-expanded', 'false');
  expect(menu('First')).toHaveAttribute('aria-activedescendant', '');
  expect(menu('Second')).toHaveAttribute('aria-activedescendant', option('Second option').id);
});

it('closes the option owner before invoking its action', async () => {
  const onFirst = vi.fn(() => {
    expect(document.activeElement).toBe(button('First'));
  });
  render(MenuIsolationTest, { onFirst });
  await fireEvent.keyDown(button('First'), { key: 'ArrowDown' });
  await fireEvent.keyDown(button('Second'), { key: 'ArrowDown' });
  await fireEvent.click(option('First option'));
  expect(onFirst).toHaveBeenCalledOnce();
});

it('lets a standalone option hover without selecting an unrelated menu', async () => {
  render(MenuIsolationTest);
  await fireEvent.keyDown(button('First'), { key: 'ArrowDown' });
  await fireEvent.mouseOver(option('Standalone option'));
  expect(option('Standalone option')).toHaveClass('active');
  expect(menu('First')).toHaveAttribute('aria-activedescendant', option('First option').id);
  expect(menu('Second')).toHaveAttribute('aria-activedescendant', '');
});

it('focuses content mounted by opening and restores the owning button on escape', async () => {
  render(MenuIsolationTest, { hideContent: true });
  button('First').focus();
  await fireEvent.click(button('First'));
  expect(document.activeElement).toBe(menu('First'));
  await fireEvent.keyDown(menu('First'), { key: 'Escape' });
  expect(document.activeElement).toBe(button('First'));
  expect(menu('First')).toBeNull();
});

it('does not focus content after opening is cancelled in the same update', async () => {
  render(MenuIsolationTest, { hideContent: true });
  button('First').click();
  document.body.click();
  await tick();
  expect(menu('First')).toBeNull();
  expect(document.activeElement).toBe(button('First'));
});

it('keeps the mirrored RTL anchor after resize', async () => {
  languageManager.rtl = true;
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 40,
    y: 60,
    width: 80,
    height: 20,
    top: 60,
    right: 120,
    bottom: 80,
    left: 40,
    toJSON: () => ({}),
  });
  try {
    render(MenuIsolationTest);
    await fireEvent.click(button('First'));
    const popup = menu('First').parentElement!;
    const before = popup.style.left;
    await fireEvent(document.defaultView!, new Event('resize'));
    expect(popup.style.left).toBe(before);
    expect(before).toBe('40px');
  } finally {
    rect.mockRestore();
    languageManager.rtl = false;
  }
});
