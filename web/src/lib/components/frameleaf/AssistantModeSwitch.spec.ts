import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages, locale } from 'svelte-i18n';
import { get } from 'svelte/store';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import en from '../../../../../i18n/en.json';
import fr from '../../../../../i18n/fr.json';
import AssistantModeSwitch from './AssistantModeSwitch.svelte';

describe('AssistantModeSwitch', () => {
  beforeAll(() => addMessages('dev', en));

  it('uses the localized product name in the selected language', () => {
    addMessages('fr', fr);
    const previous = get(locale);
    locale.set('fr');
    try {
      render(AssistantModeSwitch, { classic: false, onChange: vi.fn() });
      expect(screen.getByRole('radio', { name: 'Assistant Frameleaf' })).toBeInTheDocument();
    } finally {
      locale.set(previous);
    }
  });

  it('makes only the chosen option a Tab stop', () => {
    render(AssistantModeSwitch, { classic: false, onChange: vi.fn() });
    expect(screen.getByRole('radio', { name: 'Frameleaf Assistant' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: en.frameleaf_assistant_classic })).toHaveAttribute('tabindex', '-1');
  });

  it('moves the choice with the arrow keys', async () => {
    const onChange = vi.fn();
    render(AssistantModeSwitch, { classic: false, onChange });
    await fireEvent.keyDown(screen.getByRole('radio', { name: 'Frameleaf Assistant' }), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('gives the focus to the chosen option of the switch that replaces it', async () => {
    let classic = false;
    const first = render(AssistantModeSwitch, { classic, onChange: (next: boolean) => (classic = next) });
    const assistant = screen.getByRole('radio', { name: 'Frameleaf Assistant' });
    assistant.focus();
    await fireEvent.keyDown(assistant, { key: 'ArrowRight' });
    first.unmount();
    render(AssistantModeSwitch, { classic, onChange: vi.fn() });
    await Promise.resolve();
    expect(screen.getByRole('radio', { name: en.frameleaf_assistant_classic })).toHaveFocus();
  });
});
