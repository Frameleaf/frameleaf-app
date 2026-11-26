/** FL-1729: "⌥⇧F, ⌥⇧S and ⌥⇧L", from the shortcuts the browser has set for this extension. */
export function shortcutWords(commands: chrome.commands.Command[]): string {
  const keys = commands.map((command) => command.shortcut).filter(Boolean);
  if (keys.length === 0) return 'None set';
  return keys.length === 1
    ? keys[0]!
    : `${keys.slice(0, -1).join(', ')} and ${keys.at(-1)}`;
}
