# Landmark brand icons (first pass)

`build-icons.mjs` gathers one small square picture for every place in the landmark pack that has a brand
presence on Wikidata: a logo (`P154`), a small logo or icon (`P8972`) or an Instagram account (`P2003`).
The map shows it instead of the generic category icon once a visited place is zoomed in.

**The pictures are third-party marks, collected automatically so a person can review and replace them.**
Nothing here has had its licence or trademark position checked, which is why `out/` is not in git. Where
they may be published is still to be decided.

## Run

From `server/` (the script needs its `sharp`), with Node 24:

```sh
node base-image/geodata/landmarks/icons/build-icons.mjs \
  base-image/geodata/landmarks/landmarks.ndjson.gz base-image/geodata/landmarks/icons/out
```

A first run takes about a quarter of an hour and can be stopped and started again: places already gathered
are skipped, and a run with nothing to fetch takes under a minute.

- `--retry` asks again the websites that have not given a real icon yet (nothing, or only a `.ico`). Use it
  after the script has learnt something new, or when sites were down.
- `--force` gathers every place again. `--only Q243,Q351` and `--limit 50` (most famous first) narrow a run.
- `--self-test` checks the `.ico` decoder against a hand-built icon and exits.

The Wikidata lookup is kept in `out/wikidata.json` and only places it has not seen are asked about, so a
rebuilt pack costs little; delete the file to ask about everything again. What each download turned out to
be, the choice, the icons, the manifest and the contact sheet are worked out again from the downloads on
every run.

## Where a picture comes from

1. **Wikimedia Commons**: the `P8972` file, else the `P154` file, as a PNG rendered by Commons.
2. **The official website** (`P856`), in this order:
   1. the largest `apple-touch-icon` its homepage declares;
   2. the largest icon in its web manifest;
   3. the largest `<link rel="icon">` that is not a `.ico`;
   4. `/apple-touch-icon.png`, then `/apple-touch-icon-precomposed.png`, asked for without being declared
      (`probed` in the manifest);
   5. a declared `.ico`, then `/favicon.ico`. The largest picture in the file is used, PNG or BMP.

   Never `og:image`, which is usually a photograph.

Social networks are never fetched, and a site that blocks the crawler or does not answer is recorded as
failed. Nothing is done to get around bot protection.

## Which one is used

- The Commons picture when it is roughly square (longer side : shorter side at most 1.6, measured on the
  visible part).
- The website's icon when the Commons picture is a wide wordmark and the website has a square icon of at
  least 64 px.
- A wide wordmark when that is all there is, padded into the square (`padded`).
- The website's icon when Commons has nothing.

**Platform defaults.** A picture listed in `PLATFORM_DEFAULTS` (the WordPress "W") is nobody's mark. It is
treated as no icon (`platform default icon`) and the next candidate is tried. To add one, copy its `hash`
from the manifest into the list and run again; nothing needs fetching.

**Shared pictures.** A website icon that also turns up on a different website is flagged
`sharedAcrossSites` and never displaces a Commons picture. So far these are the marks of operators that
run several sites, and they are kept; an unknown platform default would show up the same way. The same
picture on one website (every park on a park service's site) is the operator's mark: `sharedWith` counts
the other places that got it.

## The colour behind an icon

The app draws each icon in a circle filled with the icon's own `background`, so that it reads as one badge.

- **A tile** brings its own background: a picture that fills at least 90% of its frame (a square, rounded
  corners or not), or a filled shape with a rim of one colour and a mark inside it (a disc, a shield). Its
  `background` is the colour of its rim, sampled just inside the edge all the way round
  (`backgroundFrom: "edge"`). `backgroundUniform` is false when less than 70% of the rim is that colour: a
  photograph, a gradient, a picture split in two. The colour is then the rim's dominant colour, or its
  average when it has none.
- **A mark on transparency** has no background, so it gets a neutral one (`backgroundFrom: "contrast"`):
  white, or near-black `#111315` when more than 40% of the mark would be lost on white and more of it shows
  on near-black.
- `lowContrast` marks what is still hard to read: a tile with next to nothing on it, or a mark of which
  more than 40% is lost against its backing. Contrast is the WCAG ratio; 1.8 counts as visible.

The transparent margin and any letterboxing stay transparent, so the circle's colour shows through them.

## Output (`out/`, not in git)

- `icons/<QID>.png`: 128 × 128, the picture fitted inside with a 10 px transparent margin, not cropped to
  a circle.
- `manifest.json`: one entry per place tried, most famous first: the source, its address, the Commons file
  page (for the licence review), the original size, `aspect`, `padded`, and every other candidate that was
  found. A place without an icon has `source: "none"` and a `reason`.
  - `tile`, `background`, `backgroundFrom`, `backgroundUniform`, `lowContrast`: see above.
  - `mostlyLight` / `mostlyDark`: at least 60% of the solid pixels are near-white (every channel 225 or
    more) / near-black (brightness 70 or less).
  - `hash`: of the decoded pixels; equal hashes are the same picture.
- `icons.json`: what the app and the design prototype read, and nothing else:
  `{ "<QID>": { "background": "#rrggbb", "tile": true } }` for every place that has an icon.
- `index.html`: the contact sheet, each icon drawn as the app draws it: one 38 px circle filled with its
  `background`. Edges that are not one colour and low contrast are flagged in red. Open it in a browser.
- `raw/`, `gathered.ndjson`, `wikidata.json`: the downloads and the state that makes a run resumable.

## Untrusted input

Everything fetched is treated as data. Downloads sit in `out/raw/` without a file extension and are never
run or imported. What a file is gets decided by decoding it (sharp, or the small BMP reader for `.ico`
entries, which only ever produces pixels); an icon is always sharp's own re-encoding, never the bytes or
the SVG that arrived.

## Known ceilings

- A BMP inside a `.ico` is read at 1, 4, 8, 24 and 32 bits, uncompressed. Anything else is skipped.
- Most `.ico` pictures are 16 to 48 px and look soft at 128.
- Icons declared by JavaScript, or on a page behind bot protection, are not seen.
- The website's icon is the operator's when the official website is a page on a larger site.
- A platform default used by a single place cannot be told from a real mark.
- A square mark on transparency (not a tile) is fitted to the square, so the circle clips its corners.
- A round emblem whose rim is several colours is not recognised as a tile and gets a neutral backing.
