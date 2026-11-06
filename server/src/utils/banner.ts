/**
 * The Frameleaf mark (a rounded frame, the dot of the home server, a leaf growing out of the
 * frame's corner) as plain ASCII, printed once when the container starts. Kept in step with
 * `manager/src/banner.ts`.
 */
const MARK = [
  '   .--------------------.',
  String.raw`  /                      \ `,
  ' |                  .-.  |',
  " |                  '-'  |",
  ' |          _.--~~~~|    |   %NAME%',
  " |       .-'    _.-'|    |   %VERSION%",
  " |      /   _.-'    /    |",
  " |     / .-'      .'     |",
  String.raw`  \   |/ ____..--'  _____/`,
  "   '--'-'     '---'",
];

/** Green only on a terminal that allows colour; `docker logs` and pipes get plain text. */
export const renderBanner = (
  name: string,
  version: string,
  { color = !!process.stdout.isTTY && !process.env.NO_COLOR } = {},
) => {
  const paint = (text: string) => (color ? `\u{1B}[32m${text}\u{1B}[39m` : text);
  return MARK.map((line) =>
    paint(line.trimEnd())
      .replace('%NAME%', () => name)
      .replace('%VERSION%', () => version),
  ).join('\n');
};
