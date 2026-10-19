// Shared by the server and the UI, so it imports nothing.
const parse = (tag: string) => {
  const match = /^frameleaf-v(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(tag);
  return match
    ? { parts: match.slice(1, 4).map(Number), suffix: match[4] }
    : null;
};
/** Orders frameleaf-vX.Y.Z tags by version; a suffixed tag sorts before its plain release. */
export function compareReleases(a: string, b: string): number {
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return 0;
  for (let index = 0; index < 3; index++) {
    if (left.parts[index] !== right.parts[index])
      return left.parts[index] - right.parts[index];
  }
  if (left.suffix === right.suffix) return 0;
  if (left.suffix === undefined) return 1;
  if (right.suffix === undefined) return -1;
  return left.suffix.localeCompare(right.suffix, 'en', { numeric: true });
}
export const isNewerRelease = (tag: string, running: string) =>
  compareReleases(tag, running) > 0;
