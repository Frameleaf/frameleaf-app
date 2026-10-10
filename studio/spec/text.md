# Studio render spec: titles and text (native-app contract)

**Status: native-app contract.** This page specifies how a title (an item of `type: "text"`, protocol 14.3) and a caption (the same item with `textRole: "caption"`, protocol 15) are laid out, painted and animated. It follows the rules of the [render spec](README.md): clean-room prose and mathematics, no engine source text, **implementation-defined** where the engine's behaviour is accidental, goldens taken from the real engine. Its tags are X1 to X22. The goldens are `goldens/text.json` (see [Goldens](#goldens)).

The treatment of fonts follows the ASCII effect (`effects/gpu-ascii.md`): what the platform's text engine produces (advance widths, the font's ascent and descent, and glyph coverage) is an explicit **input**. Everything computed from that input (line breaks, line boxes, baselines, run origins, the background box, the underline, the order and parameters of every draw, and every text-motion state) is pinned numerically.

## Style fields

**[X1] The fields the engine reads.** All are fields of the text item. "Range" is the range the web editor offers; the renderer clamps only where "Read as" says so, and a native client writes values inside the range. Lengths are pixels of the project canvas (X3).

| Field | Type | Range | Default when absent | Read as | Meaning |
| --- | --- | --- | --- | --- | --- |
| `text` | string | any | `""` | as stored | The title's text. U+000A starts a new paragraph. **Ignored when `textSpans` holds at least one span** (X4). |
| `color` | CSS colour string | any colour | `#ffffff` | as stored | Fill colour of the glyphs and of the underline. |
| `fontSize` | number | 8 to 500 | 60 | as stored (an animated value is at least 1, X13) | Font size in px. |
| `fontFamily` | string | a family of the font catalogue | `Inter` | as stored | Family name, never a URL (X4). |
| `fontWeight` | `normal`, `medium`, `semibold`, `bold` | the four names | `normal` | 400, 500, 600, 700; any other value 400 | Font weight. |
| `fontStyle` | `normal`, `italic` | the two names | `normal` | as stored | Upright or italic. |
| `underline` | boolean | | `false` | as stored | Underlines every line (X11). |
| `lineHeight` | number | 0.5 to 3 | 1.2 | as stored (animated: at least 0.1) | Line box height as a multiple of the line's font size (X9). |
| `letterSpacing` | number | −20 to 100 | 0 | as stored | Extra advance in px after **every** character, the last one of a line included (X5). |
| `textAlign` | `left`, `center`, `right` | the three names | `center` | any other value is read as `center` | Horizontal placement of each line (X9). |
| `verticalAlign` | `top`, `middle`, `bottom` | the three names | `middle` | any other value is read as `middle` | Vertical placement of the block (X9). |
| `textPadding` | number | 0 to 160 | 16 | max(0, value) | Inset of the text area from the box, and the margin of the background box around the text (X6, X10). |
| `backgroundColor` | CSS colour string | any colour | none | absent or empty: no background | Fill of the background box (X10). |
| `backgroundRadius` | number | 0 to 200 (a style preset may write 999) | 0 | max(0, value), then limited to half the background box (X10) | Corner radius of the background box. |
| `textShadow` | object `{ offsetX, offsetY, blur, color }` | offsets −100 to 100, blur 0 to 160 | none | all four fields required when present | Drop shadow of glyphs, stroke and underline (X12). |
| `stroke` | object `{ width, color }` | width 0 to 24 | none | drawn only when `width` > 0 | Outline of the glyphs (X12). |
| `textSpans` | array of spans | | none | entries whose `text` is not a string are dropped; an empty result counts as absent | Styled runs; replaces `text` for drawing (X4, X7, X8). |
| `spanLayout` | `stack`, `inline` | the two names | `stack` | any value but `inline` is `stack` | Each span on its own lines, or all spans flowed as one stream (X7, X8). |
| `textStylePresetId` | a preset id of `titleStyles.presets` | | none | as stored | The style preset the look came from. Read only together with an animated `textStyleScale` (X13). |
| `textStyleScale` | number > 0 | 0.5 to 6 | 1 | as stored | Scale of the style preset. **A stored value draws nothing by itself**; only an animated value rescales the preset (X13). |
| `textMotion` | object `{ in?, out?, loop? }` | protocol 13.7.1 | none | X14 | Per-character, per-word or per-line animation. |
| `textRole` | `caption` | | none | not read by the renderer | Marks a caption (X21). |

A span is `{ text, fontSize?, fontFamily?, fontWeight?, fontStyle?, underline?, color?, letterSpacing? }`. These seven are the only style fields a span can override; every other field is per item. `textLayoutDrafts`, `captionSource` and `label` are editor state and are never drawn.

The animatable title properties of protocol 13.2.5 map onto these fields: `fontSize`, `lineHeight`, `textPadding`, `backgroundRadius`, `textShadowOffsetX`, `textShadowOffsetY`, `textShadowBlur`, `strokeWidth` and `textStyleScale` (X13).

## Routes, units and resolution

**[X2] Two routes.** The engine paints text in two ways, from the same layout (X6 to X11).

- **The 2-D route** draws with the platform's vector text primitives: fill text, stroke text, Gaussian shadow. It is used for every HDR project, whenever a colour of the title is not written as `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`, and whenever the GPU is unavailable.
- **The atlas route** draws each glyph as a quad from a signed-distance atlas. It is used in SDR projects on the GPU when every colour of the title (fill, span fills, background, shadow, stroke) is written in one of those four hex forms.

The 2-D route is the **contract**: its primitives are standard and every native graphics library has them. The atlas route approximates them, and X20 lists where it differs; those differences are implementation-defined. A native client implements the 2-D route.

**[X3] Units.** Lengths are pixels of the project canvas (`metadata.width` × `metadata.height`). When a frame is rendered at another resolution, with factors s_x = rendered width ÷ canvas width and s_y likewise, and s = min(s_x, s_y): `fontSize`, `letterSpacing`, `textPadding`, `backgroundRadius`, the shadow blur and the stroke width are multiplied by s (span `fontSize` and `letterSpacing` too); the shadow's `offsetX` by s_x and `offsetY` by s_y; the box by (s_x, s_y). Layout then runs on the scaled values. `lineHeight` is a ratio and is not scaled. An export at canvas size has s_x = s_y = 1.

**[X4] Style resolution.** The **spans** of a title are its `textSpans` after dropping entries whose `text` is not a string; if none remain, the title has one span, `{ text }`, with `text` read as `""` when absent. When spans exist, the item's `text` is not drawn, even if it differs.

Each span resolves its seven fields as *span value, else item value, else default* (X1). A resolved span has a **face**: style, numeric weight, size and family. The engine names the face as the string

    <style> <weight> <size>px "<family>", sans-serif

for example `italic 600 48px "Playfair Display", sans-serif`, with the size printed as the shortest decimal that round-trips. The goldens carry this string as `font`.

- **Weight.** `normal` 400, `medium` 500, `semibold` 600, `bold` 700. The platform picks the nearest weight the family has, by the CSS font-matching rule (for a wanted weight above 500: the nearest heavier, else the nearest lighter; for 400 or 500: 400 and 500 try each other first, then lighter, then heavier). A family with only weight 400 (Anton, Bebas Neue) is drawn synthetically emboldened by the platform at 600 and 700. **Implementation-defined**: the amount of synthetic emboldening is the platform's.
- **Style.** `italic` uses the family's italic face. A family without one is drawn synthetically slanted by the platform. **Implementation-defined**: the slant is the platform's.
- **Missing family.** When the family is not available (not installed, not yet loaded, or refused), the engine measures and draws the text in the platform's default sans-serif face, at the same size, weight and style.
- **Families on a native client.** The title styles of the catalogue use seven families: Inter, Inter Tight, Anton, Bebas Neue, Orbitron, Playfair Display and Space Grotesk. A native client draws exactly these seven, from the font files the server bundles, loaded before the title is drawn; it never substitutes a system face. A title that names any other family is **not drawable on the device**: the client leaves its rendering to the server. The web editor keeps its own loader for the other families of its font catalogue.
- **Font files.** Each family, weight and style is published as two files, Latin and Latin Extended, in two formats: the WOFF2 files and a lossless TrueType or OpenType decode of each, for platforms that do not read WOFF2. A client loads the two as a **fallback chain** per family, weight and style: a character is taken from the Latin file if it has a glyph for it, else from the Latin Extended file, else from the platform's fallback fonts. Text is still measured and shaped as one run of the family; kerning between a glyph of one file and a glyph of the other is not specifiable. The goldens name the WOFF2 files they were made with and the hash of the decode of each.
- **Missing glyph.** A character the face lacks is drawn from the platform's fallback fonts. Its advance is the fallback glyph's.

**[X5] The measurer (platform input).** Layout asks the platform three things about a face F:

- **W(t, F, ℓ)**, the advance width of the string t set in F with letter spacing ℓ. The letter spacing is added after every character, **the last one included**, so W(t) = (shaped advance of t, kerning on) + ℓ × (number of characters), and W("") = 0. Two consequences are binding: a centred or right-aligned line is offset by ℓ ÷ 2 or ℓ from where its ink alone would sit, and the underline is ℓ shorter than W (X11).
- **asc(F)** and **desc(F)**, the font's ascent and descent in px at that size: the distances from the alphabetic baseline up to the top and down to the bottom of the font's bounding box (the ascender and descender of the font's own line metrics, `hhea` or the typographic metrics the platform uses for line layout). They do not depend on the text. If the platform reports 0 for either, the engine uses 0.8 × size and 0.2 × size. The engine's platform reports both as whole pixels (Inter at 60 px: 58 and 14, where the font's own values are 58.1 and 14.5). **Native rule:** round the ascent and the descent each to the nearest whole pixel before use.

Nothing else of the font enters layout. The numbers W, asc and desc are not specifiable: they belong to the font file and the platform's shaper. Given them, every formula below is exact. They are evaluated in binary64 in the order written, and the goldens are reproduced bit for bit.

## Layout

**[X6] The box.** The text box is the item's resolved transform: width B_w and height B_h, centred on the canvas centre plus (x, y); an item with no stored size takes the whole canvas. All layout coordinates are **box-local**: origin at the box's top-left corner, x to the right, y downward. Rotation, opacity and the rest of the transform apply to the painted box as to any other item.

With P = max(0, `textPadding`): the available width is A_w = max(1, B_w − 2P) and the available height A_h = B_h − 2P.

**Auto height.** Before painting, the box grows to hold its text. Let H be the block height of X9 for the width B_w, w_s the stroke width (0 without `stroke`; here not limited to ≥ 0), and g = |`textShadow.offsetY`| + `textShadow.blur` (0 without a shadow). The required height is

    H_req = H + 2P + 2·w_s + 2·g

If H_req > B_h + 0.5, the box height becomes H_req; otherwise it is unchanged. The box never shrinks, and its centre stays, so it grows equally up and down. An item with a corner pin keeps its stored height. The grown box is the box of every later step (layout, clipping, motion).

**[X7] Stack flow (the default).** Each span is laid out on its own lines, one span after another, top to bottom. For a span with text t, face F and letter spacing ℓ, the lines are WRAP(t):

1. Split t at every U+000A into **paragraphs**. No other character breaks a paragraph (U+000D stays in the text).
2. An empty paragraph gives one empty line.
3. Otherwise split the paragraph at every single U+0020 into **words**; two adjacent spaces give an empty word between them. Start with an empty current line c. For each word w in order:
   - the candidate is w if c is empty, else c + U+0020 + w;
   - if W(candidate) > A_w **and c is not empty**: emit c as a line and let c = w. If then W(w) > A_w, split w with BREAK, emit all its pieces but the last, and let c be the last piece;
   - otherwise c = candidate.
4. After the last word, emit c if it is not empty.
5. If the whole text gave no line at all, the result is one empty line.

BREAK(w) walks w one code point at a time with an empty current piece q: if W(q + character) > A_w and q is not empty, emit q and start a new piece with the character; else append the character. Emit the last piece.

The comparison is strict: a candidate exactly as wide as A_w fits. The break opportunities are U+0020 and U+000A only. There is no hyphenation, no break at a hyphen, tab, no-break space or other Unicode space, and no line-breaking rule for CJK: a run of CJK characters is one word and breaks only through BREAK. Several consequences are **implementation-defined**, and a native client reproduces them:

- Spaces at the start of a paragraph are dropped (the candidate of an empty line and an empty word is empty). Spaces inside and at the end of a line are kept and measured: the space that precedes a wrapped word is not on either line, but a second space before it stays at the end of the upper line.
- A paragraph of spaces only gives **no** line, while an empty paragraph gives one.
- The first word of a paragraph is never split, however long: BREAK runs only for a word that has just been moved to a new line. A single overlong word therefore overflows the box on its own line.
- After BREAK the last piece continues as the current line, so the next word may join it.

**[X8] Inline flow (`spanLayout: "inline"`).** All spans are concatenated, with nothing between them, into one stream that is wrapped as a whole. **The whole stream is set in the first span's face, size and letter spacing**; a later span changes only the colour and the underline of its characters (**implementation-defined**: its family, size, weight, style and spacing are ignored).

Tokens: walk the stream by code point. U+000A ends the paragraph. U+0020 ends the current word and is collected into a pending run of spaces. Any other character joins the current word; a word that starts takes the pending spaces as its **leading**. Spaces left pending at the end of a paragraph or of the stream form a word with leading and no text.

Lines, for each paragraph: an empty paragraph gives one empty line. Otherwise keep a list of words on the line and a flag *continued*, false for the first line of the paragraph. For each word: its leading counts if the line already has a word or the line is not continued; the candidate is the line's text + (that leading) + the word's text. If W(candidate) > A_w and the line has a word, emit the line, set *continued*, and start a new line with this word alone and without its leading. Otherwise add the word. Emit the last line if it has a word. So spaces are kept exactly as written, except the run of spaces at a wrap, which is dropped. An overlong word is **not** split in inline flow.

Each emitted line carries **runs**: the maximal stretches of consecutive characters from the same span. A run has the span's colour and underline, an offset o = W(the line's text before the run) (0 for the first run) and a width W(the line's text through the run) − o. The line itself has the first span's colour, and its own underline is off. Runs are defined for text in the Basic Multilingual Plane; with characters outside it the engine's run boundaries are implementation-defined.

**[X9] Lines, block and baselines.** A line set in face F of size z has:

- line height h = z × `lineHeight`;
- baseline offset b = (h − (asc(F) + desc(F))) ÷ 2 + asc(F): the font's ascent-plus-descent is centred in the line box, the surplus (which may be negative) split equally above and below;
- width w = W(line text, F, ℓ).

Lines of different spans keep their own z, h and b; in stack flow a line never mixes sizes, and in inline flow every line uses the first span's.

The block height is H = Σ h over all lines, summed in line order starting from 0. The block's top is

- `top`: T = P
- `bottom`: T = B_h − P − H
- `middle`: T = P + (A_h − H) ÷ 2

The first line's top is T, and each next line's top is the previous top plus the previous h. A line's **baseline** is y_b = top + b. Its **start** (the left edge of its advance box, where the first glyph's origin sits) is

- `left`: x_0 = P
- `right`: x_0 = B_w − P − w
- `center`: x_0 = (B_w − w) ÷ 2 (the padding does not enter)

An empty line occupies its line box and draws nothing. Text taller or wider than the box overflows it symmetrically according to the alignment; X12 says where it is clipped.

**[X10] Background box.** Drawn only when `backgroundColor` is present and not empty. It is **one rectangle for the block**, not one per line. With w_max the largest line width:

- centre x: `left` c = P + w_max ÷ 2; `right` c = B_w − P − w_max ÷ 2; `center` c = B_w ÷ 2;
- width w_b = min(B_w, w_max + 2P); height h_b = H + 2P;
- left x_b = c − w_b ÷ 2; top y_b = T − P;
- corner radius r = max(0, min(R, w_b ÷ 2, h_b ÷ 2)) with R = max(0, `backgroundRadius`). A style preset's 999 therefore gives a pill.

The box follows the text, not the item box: it is as wide as the widest line plus the padding, and never wider than the item box.

**[X11] Underline.** For an underlined line (stack flow) or run (inline flow) of font size z, baseline y_b, start x and width w:

- length u = max(0, w − ℓ): the trailing letter spacing is not underlined. Nothing is drawn when u ≤ 0;
- centre line y_u = y_b + max(1, 0.08 × z); thickness t_u = max(1, 0.05 × z);
- it is a straight stroke from (x, y_u) to (x + u, y_u), t_u thick, centred on y_u, with square (butt) ends, in the fill colour of the line or run.

The font's own underline metrics are not used. An inline run's underline starts at x_0 + o and uses the run's width.

## Painting

**[X12] Draw order (2-D route).** Inside the box, in this order:

1. **Clip.** In an export the drawing is clipped to the box rectangle (0, 0, B_w, B_h): text, stroke and shadow outside it are cut. The web editor's live preview does not clip. **Native rule:** clip in export and in playback.
2. **Background** (X10): filled with `backgroundColor`, as a rounded rectangle when r > 0. It casts **no** shadow.
3. From here on the **shadow** is in force when `textShadow` is present: every later draw also paints its own shape again, in `textShadow.color` multiplied by the shape's own alpha, displaced by (`offsetX`, `offsetY`), blurred with a Gaussian of standard deviation σ = `blur` ÷ 2 px, underneath the shape. A blur of 0 gives a hard copy. Note that an animated shadow whose three numbers are all 0 is removed (X13), and a shadow with a fully transparent colour draws nothing.
4. For each non-empty line, top to bottom:
   1. **Stroke**, when `stroke` is present with `width` > 0: the outline of the line's glyphs stroked `stroke.color`, **2 × width** wide, centred on the glyph outline, round joins. Half of it lies outside the glyph, so the visible outline is `width` px; the inner half is covered by the fill.
   2. **Fill**: in stack flow the whole line in the line's colour, from origin (x_0, y_b) on the alphabetic baseline, left to right, with the line's letter spacing and kerning. In inline flow each run in its colour from (x_0 + o, y_b).
   3. **Underline** (X11): after the line's fill in stack flow; after each run's fill in inline flow.

The stroke is drawn once per line for the whole line, also in inline flow. Because the shadow belongs to each draw, a line with a stroke casts the shadow of the stroke, then of the fill, then of the underline, each over what was drawn before: the fill's shadow lies over the line's own stroke where they overlap. Lines are drawn in order, so a later line's shadow falls on earlier lines. **Implementation-defined**; a native client reproduces the per-draw shadow.

**Colours and alpha.** The engine accepts any CSS colour string. `title.setStyle` accepts and a native client writes only `#rrggbb` and `#rrggbbaa`, stored as given; `#rrggbb` is opaque and the last two digits of `#rrggbbaa` are the alpha a = value ÷ 255. The alpha applies per draw, as coverage × a, source-over:

- **Text colour** (`color`, span `color`): the fill of the glyphs and the underline are each drawn at a. Where the fill lies over the line's own stroke, a translucent fill lets the inner half of the stroke show through.
- **Background** (`backgroundColor`): the box is filled at a; nothing else changes.
- **Stroke** (`stroke.color`): the stroke is drawn at a, under the fill.
- **Shadow** (`textShadow.color`): the shadow of a draw has alpha a_shadow × (the alpha of the shape that casts it, its colour's alpha included). A fill at 50 % under a shadow colour at 50 % casts a 25 % shadow.

The item's opacity then multiplies the whole layer.

The engine's own captions (protocol 15) hold two functional strings. The engine reads `rgb()` and `rgba()` by the CSS rules and rounds the alpha to the nearest of 255 steps, so each has an exact 8-digit form, and a native client that creates or restyles a caption writes that form: `rgba(0, 0, 0, 0.55)` is `#0000008c` and `rgba(0, 0, 0, 0.6)` is `#00000099`. In general `rgba(r, g, b, α)` is `#` + r, g, b and round(255 α) as two hex digits each. A native client that meets another CSS form in a graph (a named colour, `oklch()`) preserves it and may draw the item's default for that field. All drawing is source-over in the project's encoded SDR colour, as for any 2-D item.

**Opacity.** The painted box is one layer: the item's opacity multiplies the finished text (background, shadow, stroke, fill and underline together), not each draw. (The engine's CPU-only fallback applies the opacity to each draw separately, which makes overlapping parts show through; that is implementation-defined and not the contract.) Likewise the shadow offset is in box coordinates and turns with a rotated title.

**[X13] Animated style and `textStyleScale`.** At frame f (relative to the item's start) each of `fontSize`, `lineHeight`, `textPadding`, `backgroundRadius`, `textShadowOffsetX`, `textShadowOffsetY`, `textShadowBlur` and `strokeWidth` that has keyframes takes its interpolated value (the keyframe rules of protocol 13.2.4) in place of the stored field, limited below: `fontSize` ≥ 1, `lineHeight` ≥ 0.1, `textPadding` ≥ 0, `backgroundRadius` ≥ 0, shadow blur ≥ 0, stroke width ≥ 0. A property without keyframes keeps the stored field. Spans are untouched: a span with its own `fontSize` ignores an animated item `fontSize`.

- **Shadow.** If any of the three shadow properties is animated, or the item has a shadow, the shadow is (offsetX, offsetY, blur) with an absent number read as 0, in the item's shadow colour or `#000000`. If all three numbers are 0, there is **no** shadow at that frame.
- **Stroke.** If `strokeWidth` is animated, or the item has a stroke, the stroke has the resolved width and the item's stroke colour or `#111827`. A width ≤ 0 means no stroke.

**`textStyleScale`.** The stored number is a record of the scale a style preset was applied with. The renderer does not multiply anything by it: a title with `textStyleScale: 2` and no keyframes on it draws exactly as its other fields say.

It acts only when the item has a `textStylePresetId` **and** `textStyleScale` has keyframes. Then, at each frame, with σ the interpolated value, the item is restyled from the preset of that id before the other animated properties are resolved. With `fields` and `fontSize` the preset's catalogue entry (`titleStyles`, protocol 14.3.2) and **step** computed from the canvas height as there:

| Field | Value at scale σ |
| --- | --- |
| `fontSize` | round(round(step × multiplier) × σ) |
| `letterSpacing` | `fields.letterSpacing` × σ |
| `textPadding` | round(`fields.textPadding` × σ) |
| `backgroundRadius` | 999 if `fields.backgroundRadius` is 999, else round(`fields.backgroundRadius` × σ) |
| `textShadow` | offsets and blur × σ, same colour; absent if the preset has none |
| `stroke` | width × σ, same colour; absent if the preset has none |
| every other field of `fields` | as in the catalogue (family, weight, style, underline, colour, background colour, alignment, line height) |

round is to the nearest integer, halves towards positive infinity. `backgroundColor`, `textShadow` and `stroke` that the preset lacks are removed. If the title has spans, span k is also restyled: it keeps its text and takes the style fields of the preset's template span min(k, last template span), which override the span's own. The template spans are, with z the scaled `fontSize` above:

| Preset | Template spans (fields each one sets) |
| --- | --- |
| `speaker-card` | 1: weight bold. 2: size max(20, round(0.44 z)), weight medium, colour `#cbd5e1`. |
| `lower-third` | 1: weight bold. 2: size max(22, round(0.54 z)), weight medium, colour `#cbd5e1`. |
| `quote` | 1: style italic. 2: size max(18, round(0.4 z)), style normal, weight medium, colour `#cbd5e1`, letter spacing 1. |
| `breaking-update` | 1: size max(16, round(0.28 z)), weight bold, colour `#fca5a5`, letter spacing 2. 2: nothing. 3: size max(20, round(0.38 z)), weight semibold, colour `#fde68a`. |
| `headline-stack` | 1: size max(16, round(0.3 z)), weight semibold, colour `#fbbf24`, letter spacing 2. 2: nothing. 3: size max(20, round(0.42 z)), weight medium, colour `#cbd5e1`. |
| `launch-stack` | 1: size max(16, round(0.26 z)), weight bold, colour `#67e8f9`, letter spacing 2. 2: nothing. 3: size max(20, round(0.4 z)), weight medium, colour `#bfdbfe`. |
| `event-card` | 1: size max(18, round(0.28 z)), weight bold, colour `#fca5a5`, letter spacing 2. 2: nothing. 3: size max(22, round(0.38 z)), weight semibold, colour `#bfdbfe`, letter spacing 1. |
| `badge` | 1: letter spacing 2. |
| the other five | none: spans keep their own style fields. |

The span letter spacings 1 and 2 are not scaled. This restyling is the same computation the web editor runs when a preset is applied; it is specified here because an animated scale re-runs it every frame.

## Text motion

**[X14] Slots and windows.** `textMotion` has up to three slots, `in`, `out` and `loop` (protocol 13.7.1). The catalogue's `textMotion` lists **17 presets**: 8 for `in`, 5 for `out`, 4 for `loop` (X18). Motion is a pure function of the frame f relative to the item's start (f = 0 on its first frame), the item's length D in frames, and the unit a glyph belongs to. It has no state and no dependence on the frame rate: all quantities are frames of the project rate.

A slot has `presetId`, `durationFrames`, `staggerFrames`, `intensity`, `order`, `easing`, `seed` and optionally `offsetFrames` and `unit`. For N units (N = max(1, unit count), X15) a one-shot slot (`in` or `out`) has a **window**:

    d = max(0, durationFrames)        s = max(0, staggerFrames)
    m = ⌊(N − 1) ÷ 2⌋ for order "center", else max(0, N − 1)
    L = d + s × m

If L > D ÷ 2 and L > 0, the window is squeezed, never cut: k = (D ÷ 2) ÷ L; d ← d × k; s ← s × k; L ← D ÷ 2. The slot's offset is o = min(max(0, offsetFrames or 0), max(0, D − L)).

**Which slot draws a glyph at frame f** (if D ≤ 0, none):

1. If `out` is present and f ≥ D − o_out − L_out: **out**, with local frame λ = f − (D − o_out − L_out). This holds to the end of the item, so with an offset the text stays exited after its window.
2. Else if `in` is present and f < o_in + L_in: **in**, with λ = f − o_in. Before o_in the local frame is negative and the units hold their hidden start state.
3. Else if `loop` is present: **loop**, started at frame o_in + L_in (0 without an `in` slot).
4. Else none: the glyph is drawn without motion.

Out wins wherever the windows meet; the slots never blend.

**One-shot state.** With r the unit's rank (X16): the unit's delay is r × s, and its progress is

- if d ≤ 0: 1 when λ ≥ r × s, else 0;
- else clamp((λ − r × s) ÷ d, 0, 1).

The preset's channels (X18) are evaluated at p = EASE(progress) (X17), with the intensity I = clamp(`intensity`, 0, 2).

**Loop state.** The cycle is c = max(10⁻⁶, `durationFrames`); the unit's delay is r × max(0, `staggerFrames`) (not squeezed); λ = f − (loop start) − delay. If λ ≤ 0 the unit is still. Otherwise the phase is p = (λ ÷ c) mod 1, the fractional part, and the channels are evaluated at p **without easing** (the slot's `easing` is ignored).

A **state** is six numbers: offset (dx, dy) in px, uniform scale, rotation in radians (positive is clockwise on screen), alpha multiplier and soften in px. A channel a preset does not set is at its identity: 0, 0, 1, 0, 1, 0. A state equal to the identity means the glyph is drawn exactly as without motion.

**[X15] Units.** The slot's unit is its `unit`, or the preset's default unit (X18). Units are counted over the **laid-out lines** (after wrapping, X7 and X8), in line order, each line walked by code point:

- `character`: every character that is not white space is a unit, numbered 0, 1, 2 … across all lines. White space belongs to no unit.
- `word`: words as Unicode text segmentation finds them (UAX #29 word boundaries, segments that contain a letter, digit or ideograph), numbered across all lines. A character that is neither white space nor in such a segment (punctuation, a symbol) joins the previous word **of its line**; at the start of a line it joins the next word of that line; a line with punctuation and no word is one unit. White space belongs to no unit. A word split across two lines by BREAK is two units. Where Unicode word segmentation is unavailable: maximal runs of non-white-space characters.
- `line`: every character of line n (white space included) is in unit n; N is the number of lines, empty lines included.
- `whole-clip`: every non-white-space character is in unit 0; N = 1, so stagger and order have no effect.

White space is U+0009 to U+000D, U+0020, U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF. A glyph in no unit is drawn without motion. Two parts of word segmentation are **not specifiable**: scripts written without spaces (Chinese, Japanese, Thai) depend on the platform's dictionary, and platforms disagree on whether letters joined by a full stop or a colon (`y.z`) are one word or two. The goldens use space-separated words without such joins.

**The unit used at a frame (implementation-defined).** The engine chooses the unit kind once per frame, from a coarse slot decision that does not yet know N, and then evaluates each glyph with the exact rule of X14. The coarse decision is the rule of X14 with every window taken as: L = min(d, D ÷ 2) when the slot's `staggerFrames` is 0, and L = D ÷ 2 when it is above 0. If the coarse decision is "none", the frame is drawn without motion. Otherwise the units are counted with the coarse slot's unit kind, and each glyph is evaluated by X14 with that N. Usually both agree. They differ only for a staggered slot between its true window's end and D ÷ 2 (or the mirror for `out`): there a `loop` slot can run on the units of the `in` or `out` slot. A native client reproduces this.

**[X16] Rank.** For unit index i of N and the slot's `order`:

- `forward`: r = i. `backward`: r = N − 1 − i.
- `center`: r = ⌊|i − (N − 1) ÷ 2|⌋: 0 in the middle, growing outward, symmetric pairs equal.
- `random`: a shuffle fixed by (N, `seed`). Take the list 0 … N − 1 and the generator G below. For j from N − 1 down to 1: let q = ⌊G() × (j + 1)⌋ and swap entries j and q. The unit at position k of the result has rank k.

G is seeded with a = (`seed` truncated to a 32-bit signed integer) + 2654435769 (as an ordinary sum, not wrapped). Each call: a ← (a + 1831565813) wrapped to a 32-bit signed integer; t ← MUL32(a XOR (a ⋙ 15), a OR 1); t ← (t + MUL32(t XOR (t ⋙ 7), t OR 61)) XOR t, the sum taken exactly and then wrapped to 32 bits by the XOR; the result is ((t XOR (t ⋙ 14)) as an unsigned 32-bit integer) ÷ 2³². ⋙ is the unsigned shift and MUL32 the low 32 bits of the product, signed.

**[X17] Easing.** EASE(t) for t in [0, 1]:

- `linear`: t. `ease-in`: t². `ease-out`: t(2 − t). `ease-in-out`: 2t² for t < 0.5, else −1 + (4 − 2t)t.
- `overshoot`: with u = t − 1 and c = 1.70158: 1 + (c + 1)·u·u·u + c·u·u. It passes 1 (the maximum is about 1.10 near t = 0.7) and ends exactly at 1.

**[X18] Presets.** z is the font size of the glyph's line, B_w the box width, I the intensity, i the unit index, p the eased progress (one-shot) or the phase (loop). clamp01 limits to [0, 1]. Products are taken left to right as written. "Defaults" are what the catalogue's `textMotion.defaults` holds (duration, stagger in frames; every default has intensity 1, seed 0, and order forward unless noted).

| Preset | Slot | Unit | Defaults: duration, stagger, easing | Channels |
| --- | --- | --- | --- | --- |
| `typewriter` | in | character | 1, 2, linear | alpha = 1 if p ≥ 1, else 0 |
| `fade-up` | in | word | 12, 3, ease-out | alpha = clamp01(p); dy = (1 − p) × 0.25 × z × I |
| `rise` | in | word | 14, 4, ease-out | alpha = clamp01(p × 1.5); dy = (1 − p) × 0.6 × z × I |
| `cascade` | in | character | 10, 1, ease-out | alpha = clamp01(p); dy = −(1 − p) × 0.8 × z × I |
| `pop` | in | word | 10, 3, overshoot | alpha = clamp01(p × 2); scale = max(0, 1 + (p − 1) × I) |
| `blur-in` | in | word | 14, 3, ease-out | alpha = clamp01(p); soften = max(0, (1 − p) × 0.4 × z × I) |
| `slide-mask` | in | line | 12, 5, ease-out | dx = −(1 − p) × B_w × I |
| `wave-in` | in | character | 12, 1, ease-out | alpha = clamp01(p); dy = (1 − p) × sin(0.9 i) × 0.5 × z × I |
| `fade-down` | out | word | 12, 3, ease-in | alpha = clamp01(1 − p); dy = p × 0.25 × z × I |
| `sink` | out | word | 14, 4, ease-in | alpha = clamp01(1 − p); dy = p × 0.6 × z × I |
| `pop-out` | out | word | 10, 3, ease-in | alpha = clamp01(1 − p); scale = max(0, 1 − p × I) |
| `blur-out` | out | word | 14, 3, ease-in | alpha = clamp01(1 − p); soften = max(0, p × 0.4 × z × I) |
| `typewriter-erase` | out | character | 1, 2, linear, order backward | alpha = 0 if p ≥ 1, else 1 |
| `pulse` | loop | word | 36, 0, linear | scale = 1 + 0.06 × I × sin(2π p) |
| `wave` | loop | character | 30, 3, linear | dy = 0.18 × z × I × sin(2π p) |
| `shimmer` | loop | word | 24, 0, linear | alpha = clamp01(1 − 0.35 × I × (0.5 + 0.5 × sin(2π × (p + HASH1(31 × `seed` + i))))) |
| `swing` | loop | character | 32, 2, linear | rotation = 0.09 × I × sin(2π p) |

HASH1(v): w = ((v rem 4096) + 4096) rem 4096 with rem the remainder that takes the dividend's sign; x = sin(w × 12.9898 + 78.233) × 43758.5453; HASH1 = x − ⌊x⌋. 2π is 2 × the binary64 π.

Positive dy is downward: `fade-up` and `rise` start below their place and rise into it, `cascade` falls from above, `fade-down` and `sink` drop. `slide-mask` starts a full box width to the left, so the box clip (X12) hides it and it slides in from the box's left edge: the clip is what makes the mask. With `overshoot`, p passes 1: `pop` grows beyond its size and settles. The sine values make `wave-in`, `pulse`, `wave`, `shimmer` and `swing` reproducible to the precision of the platform's sine (the goldens allow 10⁻¹² for them); every other preset is exact.

**[X19] Painting with motion (2-D route).** A frame f is drawn glyph by glyph when the item has `textMotion`, D > 0, f ≥ 0, and at least one of: a `loop` slot exists; an `in` slot exists and f < min(D, max(0, in offset) + U_in); an `out` slot exists and f ≥ max(0, D − max(0, out offset) − U_out), where U = D ÷ 2 for a slot with `staggerFrames` > 0 and min(max(0, `durationFrames`), D ÷ 2) otherwise, and the offsets are the stored ones, not limited. Every other frame, and every such frame whose coarse slot (X15) is "none", is drawn as X12. This test covers every frame on which a glyph can be away from its identity.

On a glyph-by-glyph frame the clip, the background (never animated) and the shadow are as in X12. Then for each non-empty line:

1. Walk the line by code point with a pen starting at x_0. For each character, its advance a = W(the character alone, F, 0): **each character is measured alone, so kerning between characters is lost on these frames** (implementation-defined).
2. A character other than U+0020 is drawn at origin (pen, y_b): take the state of its unit (none if it is in no unit). If the state exists and its alpha is 0 or less, the glyph is skipped. Otherwise the glyph is drawn, stroke first then fill as in X12, in its run's colour (inline flow) or the line's, under this transform, applied to the glyph in this order: scale by `scale` about the pivot, rotate by `rotation` about the pivot, then translate by (dx, dy). The pivot is (pen + a ÷ 2, y_b − 0.3 × z). The glyph's alpha is multiplied by the state's alpha, and when soften > 0 the glyph (stroke and fill, before its shadow) is blurred with a Gaussian of standard deviation `soften` px.
3. The pen advances by a + ℓ after every character, spaces included.
4. After the line's glyphs, a line with underline (stack flow) draws its underline (X11) with the state of the line's first unit (the first character of the line that is in a unit), with the rotation dropped: scaled about (x_0 + u ÷ 2, y_b), translated by (dx, dy), alpha multiplied; skipped when that alpha is 0 or less. Underlines of inline runs are **not drawn** on glyph-by-glyph frames (implementation-defined).

The shadow of a moving glyph moves, fades and blurs with it. Motion happens inside the box, before the item's own transform, opacity and effects, and composes with them as any drawn content does.

## The atlas route, captions, and limits

**[X20] Atlas route differences (implementation-defined).** In SDR on the GPU, with hex colours only (X2), the engine draws the same layout from a signed-distance glyph atlas. A native client does not copy these; they are listed so that a comparison against the web editor is read correctly.

- **Box.** The text is rendered into a texture of ⌈B_w⌉ × ⌈B_h⌉ px (at least 2 × 2) and laid out for that rounded size; it is always clipped to it.
- **Measuring.** W(t) is the sum of the advances of the characters measured one at a time (no kerning, no shaping across characters) plus ℓ × (the length of t in UTF-16 units). Line breaks can therefore differ from the 2-D route for the same text.
- **Glyph shape.** Each glyph is rasterised once at its size, thresholded at 50 % coverage, and turned into a distance field of radius 8 px; edges are a smooth ramp about 0.5 px wide. Fine detail under about one pixel is lost.
- **Stroke.** An outward band of `width` px, at most 7.8 px, under the fill, with rounded outer corners; there is no inner half.
- **Shadow.** A copy of each glyph (without its stroke) in the shadow colour at the offset, its edge ramp widened by `blur` ÷ 2 px to each side. It is not a Gaussian. Each glyph's shadow is drawn just before that glyph, so it lies over the glyphs drawn earlier on the line. The background has no shadow.
- **Underline.** A rectangle whose **top** is at y_u, t_u high (the 2-D route centres the stroke on y_u), with its own shadow copy.
- **Motion.** The same states (X14 to X18). The pivot is the centre of the glyph's ink bounds, not the point of X19. Soften widens the edge ramp instead of blurring. Inline-run underlines are drawn, without motion.
- **Colours with alpha** (`#rrggbbaa`) multiply fill, stroke, shadow and background separately.

**[X21] Captions.** A caption made by `captions.set` (protocol 15) is a text item with `textRole: "caption"`. It is laid out, painted and animated by this page with no difference; `textRole` only tells the editor how to list it. Its standard look (protocol 15) uses the background colour `rgba(0, 0, 0, 0.55)` and a shadow colour `rgba(0, 0, 0, 0.6)`, which are not hex colours, so the web editor always paints captions on the 2-D route (X2).

The engine has a second caption carrier, the subtitle segment (`type: "subtitle"`), which `captions.set` removes and no native command writes. For reference: it holds timed cues; at frame f it shows the first cue with start ≤ (f − item start) ÷ fps < end, parses the cue's inline markup (italic, bold, underline and font-colour tags, and the ASS alignment override, numpad layout) into spans and an alignment, and draws them as a stack-flow title with the segment's own style fields and no text motion. A native client that meets one in a graph preserves it and may leave it undrawn.

**[X22] What is not specifiable, and what is binding.**

Not specifiable (platform input, as for ASCII glyphs):

- glyph outlines and their rasterisation: anti-aliasing, hinting, sub-pixel positioning, synthetic bold and italic;
- the shaper: kerning, ligatures, contextual forms, bidirectional reordering, fallback fonts, and therefore the advance W of a string;
- the font's ascent and descent as the platform reports them;
- word boundaries in scripts written without spaces (X15);
- the exact pixels of a blurred shadow and of a round-joined stroke.

Binding, given the platform's W, asc and desc:

- the line breaks (X7, X8), every line's top, height, baseline, start and width (X9), bit for bit in binary64;
- the background rectangle and radius (X10) and the underline's position, length and thickness (X11);
- the auto height (X6);
- the order, geometry and parameters of every draw: stroke width 2 × width with round joins under the fill, shadow offset and σ = blur ÷ 2 on every draw after the background, clip (X12);
- the animated style rules and the `textStyleScale` restyling (X13);
- every text-motion state: slot, window, rank, easing and channels (X14 to X18), bit for bit except through the sine, and the glyph transform of X19.

## Goldens

`goldens/text.json` is written by `../tools/text-goldens.browser.mjs --write`, which drives the engine's own layout, renderer and motion evaluator. `../tools/text-goldens.mjs` holds the case list and an independent reference written from this page; `../tools/text-goldens.test.mjs` requires the reference to reproduce every numeric value without the engine.

- **Fonts.** The `platform` cases load the bundled title fonts from files, never from the network or the system: the 64 WOFF2 files of the seven `@fontsource` packages at version 5.3.0 that `server/src/utils/studio-fonts.generated.ts` lists (weights 400, 500, 600 and 700, italic where the family has one, the Latin and Latin Extended subsets, each with the Unicode range its package declares). `fonts` in the goldens names every file with its SHA-256 and the SHA-256 of its TrueType decode, and so does this table; the other cases use no font at all.

  | WOFF2 file (under `server/node_modules/`) | SHA-256 of the WOFF2 file | SHA-256 of its TrueType decode |
  | --- | --- | --- |
  | `@fontsource/inter/files/inter-latin-400-normal.woff2` | `8909904ab6c872eb994093482a88a28eca2cd95912d7b6fecd72103b0dc07edc` | `7c7c718a62e315a83fb5b5b0b086028bae10fc153701cf0f0b168e5f5a0c28f9` |
  | `@fontsource/inter/files/inter-latin-ext-400-normal.woff2` | `6744a7f509ebc6ab220a6cd4ea77e898adf014f03d88dcda5d45d8a9feefb4e9` | `8b29e950f60ba1b68c8360a8e5e39db6e4ae9189c3459f3a158e9c8f91afe6d0` |
  | `@fontsource/inter/files/inter-latin-500-normal.woff2` | `f3779f1efccc4bdcdf9c0a02ab95bf6bd092ed09c48c08cedc725889edd1d19f` | `f1bc97421091e36fe0b302e280119c2ca34fb56049964db2c73de4daa6c15b9f` |
  | `@fontsource/inter/files/inter-latin-ext-500-normal.woff2` | `2c6fbc42d315528beb06c1096df45487bf4186c4b78b8111d12c9c951f8acca2` | `ed3b622cd73e02b21ce6ace816764e73a858691f0d84a8234957d88a2166ea56` |
  | `@fontsource/inter/files/inter-latin-600-normal.woff2` | `f9a06e79cd3a2a20951c0f0e28f66dd0e6d3fda73911d640a2125c8fcb78f21a` | `fb6efb6500fe6531b73c7a06d025ceaefc562ee03e9d840c76d48ee11e85b998` |
  | `@fontsource/inter/files/inter-latin-ext-600-normal.woff2` | `e4bdf67b0cd15ca9e184509275be95db942195d3cc2b17f6a0452f2adf75d0bf` | `aafcbe0f76a15721640b8d5d47c65caac8123b7cb294e1074b0b3d5f6897fe65` |
  | `@fontsource/inter/files/inter-latin-700-normal.woff2` | `6f56409fd3d64bb85f7d070bce20749db2d66b6d63cec586cc22d1c761be2491` | `e0b3cad6de618fb83ef2dec26499beb6011a90971090a63dcf904670e13c53ec` |
  | `@fontsource/inter/files/inter-latin-ext-700-normal.woff2` | `143f9504f1377012aa3e39c90c4354ef429cb0494b9ac0e1437f1a81e5412236` | `db3afd72b23e5cf19ad9e5bb916d7a5098559d3aaa281033dd38a868639b0da0` |
  | `@fontsource/inter/files/inter-latin-400-italic.woff2` | `7ea9d2f1274cebee837f0c6eebb426c18fbb2333a6b6da4d02ec5cf47db7fb8e` | `a7ba45aa1282969d1acc15a752a60c2a556e9bf913ab9174abc72790d9ccbc93` |
  | `@fontsource/inter/files/inter-latin-ext-400-italic.woff2` | `1edee689a85979c6c2f2b5c4d8b2d99994e57b7ac8e7f50d01cf842950a2f554` | `a37060102c8f5cd824444aa0ff392030ef517dffcf768ec3151d79b93b95baf5` |
  | `@fontsource/inter/files/inter-latin-500-italic.woff2` | `ec7b5fad608d36d16f65939bd09e70b4bb81446fa7ee32b345d0c2e4fcd174b7` | `19a5478f255300659a740c31c263290032d30aba606806ad81355ab95575eb3b` |
  | `@fontsource/inter/files/inter-latin-ext-500-italic.woff2` | `b1b7d9a28e0326ed62303240b585eb28f24684be5f64d5972fd124e707c8d168` | `99f046d951bde0ef6ddb8ce440f00c2e02075a9ebefe2e67528608970c2876d6` |
  | `@fontsource/inter/files/inter-latin-600-italic.woff2` | `c45ec86655c4614e7db0b9d2ea00303c1b252dae5671227aae5955f696069de6` | `1b1266914d72d8f48f2987936a34ff6b38f1f6a762ab2bcdb8fcc9061924eb5e` |
  | `@fontsource/inter/files/inter-latin-ext-600-italic.woff2` | `298e326a12b28c88bc14aac801d34be1f43077703254e180688ce3110985bf28` | `f28f34f49f79b2a34dfc935a0bef105013d0bdbdd154daa749ebe82cdac6f896` |
  | `@fontsource/inter/files/inter-latin-700-italic.woff2` | `facd8f930c88e4bf79be48afe46671c9dd72f82cf5f4311acc84a48e616ea169` | `be281bc88fdbe2912e82b1e36f5afea1948c0a141617977210ca8ce5c07422b2` |
  | `@fontsource/inter/files/inter-latin-ext-700-italic.woff2` | `d071e4fc8d35e023eb25adc8a3de43c6167cb718d118e413a7bce97d6ab38e26` | `a82afb781b4d0b53d2a892871fadadaca91239296d74ec57face3145568dea95` |
  | `@fontsource/inter-tight/files/inter-tight-latin-400-normal.woff2` | `6f32da94d4f26e98cb6ccd97034d306aa38945322c816f54a93c7d15dc0905b8` | `045c3ecbfb1b215290a82196a0d1d8fcfd59324a3d811abd9522b5a2f033976c` |
  | `@fontsource/inter-tight/files/inter-tight-latin-ext-400-normal.woff2` | `947ebce4da81e210b247cdc5eb7ab968eaa6bd12ad2ace2f21681e3756415f34` | `fb423a96edd11e140bb789082218c971c2977751102cd222d39f43ed1ae308f3` |
  | `@fontsource/inter-tight/files/inter-tight-latin-500-normal.woff2` | `6c0019f88d5bc179f2c972998ed8c14e779254566da9081c5e29f364a0a0aeb6` | `f0801061c3ebc7310c69beeb8031dae53f6301e3420339f40d94af221b025f8f` |
  | `@fontsource/inter-tight/files/inter-tight-latin-ext-500-normal.woff2` | `ea6e0ae0639c8d6d2292ca385e0aa0514ee76c8258f6ae46af779214f2ab0142` | `8685482c8f52ee6cbd26e72091c62a26acbdc7137ae41239222be3d83993b7e2` |
  | `@fontsource/inter-tight/files/inter-tight-latin-600-normal.woff2` | `db1a039d03ed646ef6a899f9ff92bf2f6fe382a49f1b0992066e85caf88b5be9` | `0d17a122341e47ff86d54d35c1d4c9c53776eee58fca7e71650b245666087db4` |
  | `@fontsource/inter-tight/files/inter-tight-latin-ext-600-normal.woff2` | `0bc08fdb02baa81e9379b64afba2b34bbe8bf34e2112f9bdd2ab9c30aa778060` | `9a4075775aa66e889eb22072537f254c57862fe9fd87aaecbbe1ef8e41a6d7cc` |
  | `@fontsource/inter-tight/files/inter-tight-latin-700-normal.woff2` | `9c4f02f38678f2628292d66c4f7a1a6a06af7ffac4d279359b09074e7d0f1fe0` | `a7f53e49ddeb062c6ca67ac729806c63d57f236fbd8dab609d575657dc7b12a4` |
  | `@fontsource/inter-tight/files/inter-tight-latin-ext-700-normal.woff2` | `cf4f153e89808686667d5eef31ae4926e2e8e3dc261fa664096432dcf72d5d79` | `6eb5b31fdb7fe2394525b58789cc03c553b25569988e9ec49d5398cf938a67cb` |
  | `@fontsource/inter-tight/files/inter-tight-latin-400-italic.woff2` | `046763e7dd7dfedccdcec738a72ad91fbbec14dbbae30d9946a33305eef2b2b3` | `954625a29d09838bcd64ccd377b6a909bb300c405a415382df115dbb6872ef32` |
  | `@fontsource/inter-tight/files/inter-tight-latin-ext-400-italic.woff2` | `0698e0f8bbd4b9203b3d5402d43b02b4f6f8cdc908dbe8fe0a773d4e5c702948` | `9724f1887c66874b321958a60ffe5dbcfe5b56867c1bcce60f14d963400c2566` |
  | `@fontsource/inter-tight/files/inter-tight-latin-500-italic.woff2` | `605b362d5e522e412ad6d5e4985db90bd5783644e0b1dfae73053621ae2eb440` | `ee9e8daea7c8780ffc4f93ca9e263018ef730d90d8c6dbac2d109e7e78c151fb` |
  | `@fontsource/inter-tight/files/inter-tight-latin-ext-500-italic.woff2` | `0c1945d09acfc4a4595ce0c6686469f75cd9a51c14f3295a568407a45903627a` | `8f44581757c013e872fc0e6f0e71a9cbf0266918bdb3a8e6e570cca452c9aa87` |
  | `@fontsource/inter-tight/files/inter-tight-latin-600-italic.woff2` | `c00ab2de3082c5587a8a010f3a1902a8522b432a07bbb0ef9e8dc844adc9e6e6` | `ce2f05d433bdde0a0fac6afc0601b92ce12348bb0ccfa963392f4a48d050e8d7` |
  | `@fontsource/inter-tight/files/inter-tight-latin-ext-600-italic.woff2` | `8618813ff59d3ae51125084773d076a85c6d86981196a81520d300c6fe3254fc` | `2559847e295a94aee8c132d56c2cde7ac921feb694f53144c7194707c81113b1` |
  | `@fontsource/inter-tight/files/inter-tight-latin-700-italic.woff2` | `379ffc3e29cf24fcc37df732cc5213a8d30f84e0c2878f0daaa220ebbd83d604` | `427b062b0d6cc9f9e5c0c651320becc9c344d132f8dcd5404c7e9aeb12b1b849` |
  | `@fontsource/inter-tight/files/inter-tight-latin-ext-700-italic.woff2` | `2aa5c9095099ef064f23282bb83a5a0254ca5e438d68a1db3746aa8e9ed4488b` | `9c15e7f1e6facc9a4bc76413572dd1cd09134ec962a114646708803d1b1936d7` |
  | `@fontsource/anton/files/anton-latin-400-normal.woff2` | `d0fa07ff63dd60cbc0e2f58e29c802dca2a5ae0276c999f59c6111ab7bbaec3b` | `56ff0da14df67cbdd38d47bd657c7bb65c3defe2af792472c895c21cb1c4e341` |
  | `@fontsource/anton/files/anton-latin-ext-400-normal.woff2` | `0d17b7880f389deeb6663a52fa4eadc6d9116bdda725f0aa1f3d404fbb7d3d59` | `26e6c6a32bf479b2a925456c24e40839cbc854d85b7cb72e0831b5fcb2ded1ba` |
  | `@fontsource/bebas-neue/files/bebas-neue-latin-400-normal.woff2` | `a7c90c89240c134f7fdd33d40c000ec90b79d675ea53e8cc5a6d423c073de412` | `1551a5e5f8c3288fcb62dd7438525748e3e541d58683911392da95883bcbfa4e` |
  | `@fontsource/bebas-neue/files/bebas-neue-latin-ext-400-normal.woff2` | `16c95ce45a2922f52551d38d565d14c92cf257b8f219c89613407d81fdd21a39` | `705128280184c077fd80a4c3fb80a3f03db4006a77616583bc11d40fb760c5e5` |
  | `@fontsource/orbitron/files/orbitron-latin-400-normal.woff2` | `9320ca80be2f4275e7aaa009bc058b9ea46264d4f92b06f0b822c3405cf45841` | `e42ef51edce3dfdb56a342788407916f9909f3bbc8ebb83b8f6d1e080486a81d` |
  | `@fontsource/orbitron/files/orbitron-latin-500-normal.woff2` | `c13360768270c65d6c97701b100a88993885671dfdfd2a400aa58ea0195381ea` | `3d35832579e32c804462e7e26df2da664a2da35c13c41275896860d7a8969719` |
  | `@fontsource/orbitron/files/orbitron-latin-600-normal.woff2` | `585062e775d70397653192777533f65f3afb707320fcc2a4bc510470e03762e6` | `df3666268afa58858cf4465bccefbc0d36597f1cddf6e763ba1fa95437e3c67d` |
  | `@fontsource/orbitron/files/orbitron-latin-700-normal.woff2` | `ee6acc5ad5349018f9ca71fab8118144160e110838931874150a1ac3f97db38d` | `a2f6ab5f24b739dc9af7a07d7fc8eb80e10f8b51a84810ac8492965cfa35b7a6` |
  | `@fontsource/playfair-display/files/playfair-display-latin-400-normal.woff2` | `1fe9ad5d8b2ebd8ecb8fbd05bed1e3fdfa52dae3f1a04e1c219918442fe9394d` | `273f4f1df76fb1c449dcbfb18e7ca33d77e8184e376f1b257b8907d6b3df2c22` |
  | `@fontsource/playfair-display/files/playfair-display-latin-ext-400-normal.woff2` | `b13dce34203d893eb00980383bc5abf8b75c9eb1f59c3a630e9fc8baf2e9984f` | `65f6ed6fc55884a01e493652f4330ba33613519a3aadb7713287dbd10e001ead` |
  | `@fontsource/playfair-display/files/playfair-display-latin-500-normal.woff2` | `1e3429a2122b4171bf393c8de5c501820e17ca2074c498d7080e2326975d825c` | `34fdb5b27d05f6427a22513c2c92ab1e04e291dfb161044562c2e2cdd9ab8e8b` |
  | `@fontsource/playfair-display/files/playfair-display-latin-ext-500-normal.woff2` | `30dee03523782294cd9b0d3ab46dfd3130c356cea831bf6cc8724e157f51846d` | `b5cfe5d0d5fa2e1b4b144851c2f195a6d5e6ef5d70700c0c716afd9b41904e80` |
  | `@fontsource/playfair-display/files/playfair-display-latin-600-normal.woff2` | `5d2286941a6b02a29387efa94809a064f8917598eafa67b938261cf13bb887cd` | `71b72985ba783d1f94c903e3d6e7b73990b31abbde87866dd605ff2c65c00e10` |
  | `@fontsource/playfair-display/files/playfair-display-latin-ext-600-normal.woff2` | `cf968562375eceed83b66f2b5445aa4ecdc4d5300de94930da06433877a975a1` | `25eed90378ad22e9ac96a88710f4a10422d32ac97c3b55e8395faf6b5a0b57c1` |
  | `@fontsource/playfair-display/files/playfair-display-latin-700-normal.woff2` | `28453852ea165c47b5a941be00e418402e1407002ed87507f062a1e316328fe6` | `36be40f50b34ae2da51608e36eae9eeaf90202d7395fa1be0186f7e257af62cc` |
  | `@fontsource/playfair-display/files/playfair-display-latin-ext-700-normal.woff2` | `edb9f5d879b30c617698bcc288692c339d5a0a2464a5476f00025195e5cad166` | `8b1583746a35f02f0c77ef1683e6136a189aeec3c5c0d0b4606052c2716944eb` |
  | `@fontsource/playfair-display/files/playfair-display-latin-400-italic.woff2` | `eabce94d4a69e439cd050755c31f9894ac8a78f93e58b063c6c01f370474e1de` | `252c0406f724dca3c87a8bf949d8bac7ba553d17730cacfda3c6dab6d8ed887c` |
  | `@fontsource/playfair-display/files/playfair-display-latin-ext-400-italic.woff2` | `b02fdf18a2d7b09f409b01a1ab4afe7b5f7d08926b3c867187398765ea0fb3f1` | `015bc155c5a1b1a434cad21764334d88cb7d427b89b0cc5fb4134b8569b10184` |
  | `@fontsource/playfair-display/files/playfair-display-latin-500-italic.woff2` | `8f074624e50ab805878b26ab5f3e0fa360043d546c35b043947e96a5c7071970` | `b57f983174c876fed31c2dc3b1b0fce2c04ae0379e8231ccacb145148746ef89` |
  | `@fontsource/playfair-display/files/playfair-display-latin-ext-500-italic.woff2` | `224ec72e732a9ccf564a90d056fc637fc29ac0be8209b0fa1a16730430d6cf02` | `ec0209aab91a9f87b967a05fc5544d8963f3b84713dd2cb3fb972bdfa689456a` |
  | `@fontsource/playfair-display/files/playfair-display-latin-600-italic.woff2` | `8176ed854ef40b2cdebbdb7a1fd9283b3dada1e87c8e89d003f3485fc3c7435b` | `2199b2378a5e6e6876b94588472ca2a3be882a913469290f9b90ae83aa437e7f` |
  | `@fontsource/playfair-display/files/playfair-display-latin-ext-600-italic.woff2` | `4f6a4778dcb42d51a922c9ee7ba5b85482473ce33e3d4eb9280912b24794b341` | `05df9ae6188c5cfb0f19edffa623054bcef3cffda090db1ec39144a36cfcc1fa` |
  | `@fontsource/playfair-display/files/playfair-display-latin-700-italic.woff2` | `de2f4041e7ef84f418bd0144484e521e8df849aff47762230c981704b9661877` | `325fab5b5070947858f54ef7373c0f9ef2ba32b97cd78c9591beaa5c9640a91a` |
  | `@fontsource/playfair-display/files/playfair-display-latin-ext-700-italic.woff2` | `8af70f52c55bb5cd12b43f2096f926280b099def7334690934282435b16ff18d` | `a193eb2c03d5c1c93160e101ff12a2ba0968481d4b409dc35d74a04597c583f0` |
  | `@fontsource/space-grotesk/files/space-grotesk-latin-400-normal.woff2` | `65fd17fcbd2e2f522940b5f67ead3d23329e02891aa5495e74d11a499c0b0673` | `50827dd9d82fe22746f14e5aa146b2310fc691d8e5e73597abce47518c161b80` |
  | `@fontsource/space-grotesk/files/space-grotesk-latin-ext-400-normal.woff2` | `a6658ce608a36f9ece7a65842725deebeb5f01df2debeb696b79c8536bf2ddc8` | `63884624327ea777ff419912fd1125f8ad7f09e9fb960154990eb5b219d2fb8d` |
  | `@fontsource/space-grotesk/files/space-grotesk-latin-500-normal.woff2` | `1b1a8131d9edf975d9decee81e2f2bf504812f7a4f498e5500f28a613e22e64c` | `b53baa9795f4c1ca4c6a510e3ad1ef5464fd8ec7d7ee02a138296ac4e2db554e` |
  | `@fontsource/space-grotesk/files/space-grotesk-latin-ext-500-normal.woff2` | `ed7e064eda944f88ce2f40101ec20e214004decdf5c0b9ad9219ae21be2dbf13` | `258c5377ccae4f483bbba938b73851716b83f72b5cdd074b5eadb60fe013eb39` |
  | `@fontsource/space-grotesk/files/space-grotesk-latin-600-normal.woff2` | `685bbbf69fa616df1ef81847c85fc76be097ddfb3468ff2257be54511ab3130f` | `f72b6b9aab24d0cd121e86be6be7a5f20c82a31c520fcbbb8f1580967db0f1f6` |
  | `@fontsource/space-grotesk/files/space-grotesk-latin-ext-600-normal.woff2` | `0bdc872e2806e0eb2ecca08221ea0b49d36efd9b9239a5744b81afbc0376e9cf` | `c5adafc45ff54bb420276b6c2b0b89e1e1bdb0f2ebb9402e836558b509e0faa8` |
  | `@fontsource/space-grotesk/files/space-grotesk-latin-700-normal.woff2` | `35f8aec56cfd5cbfdb03cc68733a54a0b05bb3617ffcd5fd332badc0b045ca55` | `e25f0bc04978bc25efd0958505a642cbe7922989139c6b622646e75a622adf0c` |
  | `@fontsource/space-grotesk/files/space-grotesk-latin-ext-700-normal.woff2` | `7ce350b706d79c955ebf91314295f39fa82999f980b7e9beee743c2f3580a15e` | `4bae94caca567eebcfd00f6b46f811f2ff885bee6b19a6798621dc02da7f2191` |

  The decode of a file has the same base name with the extension `.ttf` under `server/resources/studio-fonts/`.

- **Measurers.** Most cases use the **synthetic measurer** defined in `text-goldens.mjs`: a table of per-character advances in units of the font size, dyadic so that all arithmetic is exact, with no kerning, a factor 1.125 for weights 600 and above, asc = 0.9375 × size and desc = 0.25 × size. It is a test input, not a rule: it stands where a platform's text engine stands. The `platform` cases use the real 2-D measurer of the machine that wrote the goldens; every width and metric it returned is recorded in `platformMeasurements` as that case's input (as the ASCII atlas is), and the drift gate re-captures them on its own machine.
- **`layout` cases** give an item and a box and expect the lines (text, font, size, colour, letter spacing, underline, width, top, baseline, start, line height, runs) with the block height and background box: X4 to X10. Exact.
- **`autoHeight` cases** expect the grown box height (X6) on the platform measurer. Exact given the recorded measurements.
- **`paint` cases** run the engine's 2-D renderer against a recording surface with the synthetic measurer and expect the ordered list of draws: clip, background, stroke, fill and underline, each with its geometry, colours, shadow, alpha, blur and glyph transform (X11, X12, X19). Exact.
- **`styleScale` cases** expect the item after the animated-style resolution of X13. Exact.
- **`motion` cases** expect the six state numbers for units and frames of every preset, order and easing (X14, X16 to X18). Exact, except the five sine presets at 10⁻¹².
- **`slot` and `units` cases** expect the coarse slot (X15) at frames, and the unit index of every character of given lines for the four unit kinds (X15). Exact.
- **`image` cases** are small frames rendered by the engine's 2-D renderer on the real canvas with the synthetic measurer and text made of no-break spaces, so that no glyph ink enters: they pin the pixels of the background box, the underline, the hard and blurred shadow, the clip, and the alpha of 8-digit colours on the background, the underline and the shadow (with the `rgba()` strings of the caption preset drawing identically to their 8-digit forms). Buffers are `rgba8`, straight alpha, as in the README; tolerances are measured against a hardware backend by the README's rule and compared with its comparison rule.

Regenerate and check (Node 24, the prepared engine served by Vite):

```sh
GOLDENS_CROSS_CHECK_ARGS='--enable-unsafe-webgpu --use-angle=metal --ignore-gpu-blocklist' \
  node studio/tools/text-goldens.browser.mjs --write
node studio/tools/text-goldens.browser.mjs        # drift gate
node --test studio/tools/text-goldens.test.mjs    # engine-free
```
