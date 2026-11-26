import { buildIconPacks, iconPackNames, readIconPackNames, shapeOf } from '../../../scripts/icon-packs.mjs';

it('keeps the server name list in step with the installed icon packs', () => {
  // A pack version bump changes which icons exist: run `node web/scripts/icon-packs.mjs` and commit the result.
  expect(readIconPackNames()).toEqual(iconPackNames());
});

it('ships each pack with its licence and only names the stored icon format allows', () => {
  const packs = buildIconPacks();
  expect(packs.map(({ prefix, license }) => [prefix, license])).toEqual([
    ['tabler', 'MIT'],
    ['material-symbols', 'Apache-2.0'],
    ['iconoven', 'MIT'],
  ]);
  for (const { prefix, icons } of packs) {
    for (const name of Object.keys(icons)) {
      expect(`${prefix}:${name}`).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*:[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  }
  const [tabler, materialSymbols] = packs;
  expect(Object.keys(tabler.icons).length).toBeGreaterThan(6000);
  expect(Object.keys(materialSymbols.icons).length).toBeGreaterThan(6000);
  expect(Object.keys(materialSymbols.icons).some((name) => /-(rounded|sharp)$/.test(name))).toBe(false);
});

it('turns an icon body into a filled path, stroked paths by width, or nothing when it cannot be drawn', () => {
  expect(shapeOf('<path fill="currentColor" d="M1 1h2"/>', 24)).toBe('M1 1h2');
  expect(shapeOf('<path fill="currentColor" d="M1 1h2"/>', 32)).toEqual({ box: 32, fill: 'M1 1h2' });
  const outline = '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">';
  expect(
    shapeOf(
      `${outline}<path stroke-width="2" d="M1 1h2"/><circle cx="12" cy="13" r="2" stroke-width="1.5"/>` +
        `<rect width="6" height="4" x="1" y="2" stroke-width="1.5"/><path fill="currentColor" stroke="none" d="M5 5h1"/></g>`,
      24,
    ),
  ).toEqual({
    fill: 'M5 5h1',
    strokes: [
      [2, 'M1 1h2'],
      [1.5, 'M10 13a2 2 0 1 0 4 0a2 2 0 1 0 -4 0ZM1 2h6v4h-6v-4Z'],
    ],
  });
  for (const body of [
    '<path fill="#f00" d="M1 1h2"/>',
    '<path fill="currentColor" opacity=".3" d="M1 1h2"/>',
    '<path fill="currentColor" fill-rule="evenodd" d="M1 1h2"/>',
    '<g fill="none" stroke="currentColor"><path d="M1 1h2"/></g>',
    '<ellipse cx="1" cy="1" rx="2" ry="1"/>',
    '<defs><path id="a" d="M1 1h2"/></defs><use href="#a"/>',
    '',
  ]) {
    expect(shapeOf(body, 24)).toBeUndefined();
  }
});
