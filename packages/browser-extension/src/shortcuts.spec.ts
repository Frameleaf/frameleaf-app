import { expect, it } from 'vitest';
import { shortcutWords } from './shortcuts';
it('lists the shortcuts the browser has set, as words', () => {
  const command = (shortcut: string) => ({ name: shortcut, shortcut });
  expect(shortcutWords(['⌥⇧F', '⌥⇧S', '⌥⇧L'].map(command))).toBe(
    '⌥⇧F, ⌥⇧S and ⌥⇧L',
  );
  expect(shortcutWords(['Alt+Shift+F', '', 'Alt+Shift+L'].map(command))).toBe(
    'Alt+Shift+F and Alt+Shift+L',
  );
  expect(shortcutWords([command('⌥⇧F')])).toBe('⌥⇧F');
  expect(shortcutWords([command('')])).toBe('None set');
});
