import { tick } from 'svelte';
import { rovingFocus } from '$lib/frameleaf/roving-focus';
import { languageManager } from '$lib/managers/language-manager.svelte';

const radioGroup = () => {
  const root = document.createElement('div');
  root.setAttribute('role', 'radiogroup');
  const checked: string[] = [];
  for (const name of ['a', 'b', 'c']) {
    const button = document.createElement('button');
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(name === 'a'));
    button.textContent = name;
    button.addEventListener('click', () => {
      checked.push(name);
      for (const other of root.querySelectorAll('button')) {
        other.setAttribute('aria-checked', String(other === button));
      }
    });
    root.append(button);
  }
  document.body.append(root);
  return { root, buttons: [...root.querySelectorAll('button')], checked };
};

const press = (key: string) =>
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

describe('rovingFocus (FL-139)', () => {
  afterEach(() => {
    document.body.replaceChildren();
    languageManager.setLanguage('en');
  });

  it('makes a radio group one tab stop, and moves and checks with the arrows', async () => {
    const { root, buttons, checked } = radioGroup();
    const action = rovingFocus(root);
    expect(buttons.map((button) => button.tabIndex)).toEqual([0, -1, -1]);

    buttons[0].focus();
    press('ArrowDown');
    expect(document.activeElement).toBe(buttons[1]);
    expect(checked).toEqual(['b']);
    await tick();
    expect(buttons.map((button) => button.tabIndex)).toEqual([-1, 0, -1]);

    press('End');
    expect(document.activeElement).toBe(buttons[2]);
    press('ArrowRight');
    expect(document.activeElement).toBe(buttons[0]);
    press('Home');
    expect(document.activeElement).toBe(buttons[0]);
    action.destroy();
  });

  it('moves ← forward in a right-to-left page', () => {
    languageManager.setLanguage('ar');
    const { root, buttons } = radioGroup();
    rovingFocus(root);
    buttons[0].focus();
    press('ArrowLeft');
    expect(document.activeElement).toBe(buttons[1]);
  });

  it('only moves focus in a list box, leaving the choice to Enter or Space', () => {
    const root = document.createElement('ul');
    root.setAttribute('role', 'listbox');
    const clicks: number[] = [];
    for (const index of [0, 1]) {
      const option = document.createElement('button');
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      option.addEventListener('click', () => {
        clicks.push(index);
      });
      root.append(option);
    }
    document.body.append(root);
    rovingFocus(root);
    const options = [...root.querySelectorAll('button')];
    options[0].focus();
    press('ArrowDown');
    expect(document.activeElement).toBe(options[1]);
    expect(clicks).toEqual([]);
  });
});
