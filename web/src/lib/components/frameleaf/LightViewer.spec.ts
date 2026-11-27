import { fireEvent, render, screen } from '@testing-library/svelte';
import { createRawSnippet, tick } from 'svelte';
import { addMessages, init } from 'svelte-i18n';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import en from '../../../../../i18n/en.json';
import LightViewer from './LightViewer.svelte';

const photo = createRawSnippet(() => ({ render: () => '<img src="/cabin.jpg" alt="Cabin life.jpg" />' }));

const open = (overrides = {}) => {
  const props = {
    label: 'Looking at Cabin life.jpg',
    heading: 'Cabin life.jpg',
    position: '2 of 3',
    hasPrevious: true,
    hasNext: true,
    onPrevious: vi.fn(),
    onNext: vi.fn(),
    onClose: vi.fn(),
    children: photo,
    ...overrides,
  };
  return { props, view: render(LightViewer, props) };
};

describe('LightViewer', () => {
  beforeAll(async () => {
    addMessages('en', en);
    await init({ fallbackLocale: 'en', initialLocale: 'en' });
  });

  it('is a modal dialog named for the photo, with previous, next and close', () => {
    open();
    const viewer = screen.getByRole('dialog', { name: 'Looking at Cabin life.jpg' });
    expect(viewer).toHaveAttribute('aria-modal', 'true');
    expect(viewer).toHaveTextContent('2 of 3');
    for (const name of ['Close', 'Previous photo', 'Next photo']) {
      expect(screen.getByRole('button', { name })).toBeEnabled();
    }
  });

  it('moves with the arrow keys and closes on Escape', async () => {
    const { props } = open();
    await fireEvent.keyDown(document, { key: 'ArrowRight' });
    await fireEvent.keyDown(document, { key: 'ArrowLeft' });
    await fireEvent.keyDown(document, { key: 'Escape' });
    expect(props.onNext).toHaveBeenCalledOnce();
    expect(props.onPrevious).toHaveBeenCalledOnce();
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it('does not step past either end', async () => {
    const { props } = open({ hasPrevious: false, hasNext: false });
    expect(screen.getByRole('button', { name: 'Previous photo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next photo' })).toBeDisabled();
    await fireEvent.keyDown(document, { key: 'ArrowRight' });
    await fireEvent.keyDown(document, { key: 'ArrowLeft' });
    expect(props.onNext).not.toHaveBeenCalled();
    expect(props.onPrevious).not.toHaveBeenCalled();
  });

  it('takes the focus, keeps Tab inside, and gives the focus back to the opener', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();

    const { view } = open();
    await tick();
    const close = screen.getByRole('button', { name: 'Close' });
    expect(close).toHaveFocus();

    // Tabbing past the last control lands on the trap's end sentinel, which hands focus to the first.
    const viewer = screen.getByRole('dialog');
    viewer.querySelector<HTMLElement>('[data-focus-trap="end"]')!.focus();
    expect(close).toHaveFocus();
    // Shift+Tab before the first control wraps to the last.
    viewer.querySelector<HTMLElement>('[data-focus-trap="start"]')!.focus();
    expect(screen.getByRole('button', { name: 'Next photo' })).toHaveFocus();

    view.unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it('moves the focus to Close when the focused Next button becomes disabled', async () => {
    const { view } = open();
    await tick();
    const next = screen.getByRole('button', { name: 'Next photo' });
    next.focus();
    await view.rerender({ hasNext: false });
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus());
  });

  it('leaves the arrow keys to a field being typed in', async () => {
    const field = createRawSnippet(() => ({ render: () => '<input aria-label="Caption" />' }));
    const { props } = open({ footer: field });
    const input = screen.getByRole('textbox', { name: 'Caption' });
    await fireEvent.keyDown(input, { key: 'ArrowRight' });
    expect(props.onNext).not.toHaveBeenCalled();
  });
});
