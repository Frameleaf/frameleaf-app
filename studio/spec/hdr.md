# Studio render spec: HDR and colour management (native-app contract)

**Status: native-app contract.** This page specifies how the Studio engine decides that a project is HDR, what its working values mean, how PQ, HLG and SDR sources become working values, how an HDR project is shown on an SDR display, and how a frame is encoded for HDR delivery. It belongs to the render spec of [`README.md`](README.md) and follows its terms: it is a clean-room specification, written by reading the engine at the revision pinned there, and it holds mathematics and prose only. Rules are tagged H1 to H17; C and T tags are those of `README.md`.

Where the engine's behaviour is accidental, the page says **implementation-defined** and describes what the engine does. Where the engine has no behaviour, it says **not implemented at this revision**. A native client reproduces implementation-defined behaviour unless a native rule says otherwise.

**Owner decision on record (FL-97, 2026-09-29).** "A project is HDR automatically when it holds a PQ/HLG clip; SDR displays tone-map with BT.2390." H3 and H13 specify what the engine does for each half. [Gaps](#gaps-against-the-owner-decision) lists every place where the engine and its host differ from that sentence.

## The colour-management record

**[H1] `metadata.colorManagement`.** An optional object of the graph's `metadata` (protocol 2.2). The engine reads four fields. It never writes the object, and neither does the web host: at this revision nothing creates it, and a graph that holds one keeps it only because unknown content is preserved (protocol 2.5).

| Field | Values | Read as |
| --- | --- | --- |
| `workingRange` | `"sdr"`, `"hdr"` | `"hdr"` forces an HDR project. Any other value, `"sdr"` included, forces nothing: the sources still decide (H3). |
| `referenceWhiteNits` | number > 0 | W, the luminance in cd/m² of working value 1.0 in an HDR project. Default 203. |
| `masteringPeakNits` | number > 0 | P, the source peak of the SDR tone map (H12, H13). Default 1000. It has no other use: it is not the HLG nominal peak (H7) and it is not delivery metadata (H15). |
| `sdrMonitoring` | `"bt2390"`, `"none"` | How an HDR project is converted for an SDR display (H13). Default `"bt2390"`. |

The record holds no transfer function, no primaries and no bit depth. The working space is fixed by the working range (H4), and the delivery transfer (PQ, HLG or SDR) is chosen by each export request, never by the project (H14).

**[H2] Resolution.** Every frame, the engine resolves the record together with the source range s of H3 into four values:

- range = `hdr` if `workingRange` is exactly the string `"hdr"`, or s is `hdr`; otherwise `sdr`.
- W = `referenceWhiteNits` if it is a finite number greater than 0; otherwise 203.
- P = `masteringPeakNits` if it is a finite number greater than 0, otherwise 1000; then P = max(W, P).
- policy = `none` if `sdrMonitoring` is exactly `"none"`; otherwise `bt2390`.

A missing record, a record that is not an object, a numeric string, zero, a negative number, and an unknown policy name all resolve to the defaults. Fields the engine does not read are ignored. W and P are resolved for SDR projects too; W then matters only when an SDR project is delivered as PQ or HLG (H14).

**Native rule.** A native client resolves the record exactly this way, preserves a record it finds, and does not create or change one. In particular it never writes `sdrMonitoring: "none"`, which exists for measurement only, and it does not write `workingRange` when a clip is placed or removed, because the engine does not.

## When a project is HDR

**[H3] The automatic rule.** Whether a project is HDR is not stored. It is derived from the media records (protocol 3.5) of the media the timeline places, every time a frame is rendered:

1. Take every item of every track of the timeline the renderer was given, at any frame, whether or not it is visible at the frame being drawn. The preview is given the whole main timeline. An export of an in–out range is given only the main-timeline items that overlap the range.
2. For an item of type `composition`, take the items of the composition it names instead, recursively: the composition's own item list when it has one, otherwise the items of its tracks. Each composition is entered once, so a cycle ends, and an unknown composition contributes nothing.
3. For any other item that has a `mediaId`, take the `colorTransfer` of that media record. An audio item counts like a picture item. An item with no record, or a record with no `colorTransfer`, contributes nothing.
4. s = `hdr` if any transfer taken is `"pq"`, `"hlg"` or `"hdr"`; otherwise `sdr`. The comparison is exact: other spellings, such as `"PQ"` or `"smpte2084"`, are SDR.

`colorTransfer` is a field of the media record, not of the graph: `"sdr"`, `"pq"`, `"hlg"`, or `"hdr"` (HDR, transfer not stated). When the engine probes a video itself, it sets `"pq"` or `"hlg"` when the decoder reports exactly that transfer, and `"sdr"` for anything else. The web host sets `"hdr"` for each library video the server reports as an HDR original (a PQ or HLG picture stream, or any Dolby Vision profile).

So a project becomes HDR on the first frame rendered after such a clip is placed or its record becomes known, and it stops being HDR on the first frame after the last such clip is removed, unless the stored record forces `hdr` (H1). Nothing is written to the graph in either direction.

**Implementation-defined.** Because an export of a range sees only the items that overlap it, a range of an HDR project that touches no HDR clip is rendered and exported as an SDR project. A renderer that is given HDR stills as rasters (H11) is HDR for as long as it holds any, whatever the graph says.

**Native rule.** A native client evaluates this rule for every frame, and builds each video's media record with the `colorTransfer` below. The record is the client's own view of the asset (protocol 3.5): no command carries it, it is not in the graph and it is not sent to the server, so the client writes it directly, as the web host does. The value comes from the transfer characteristics of the original's picture stream (ITU-T H.273), read from the stream by a client that can, or from the server's report otherwise:

| Original's picture stream | `colorTransfer` |
| --- | --- |
| transfer characteristics 16 (SMPTE ST 2084, PQ) | `"pq"` |
| transfer characteristics 18 (ARIB STD-B67, HLG) | `"hlg"` |
| any Dolby Vision profile, whatever its transfer characteristics; or known to be HDR from the server's report alone | `"hdr"` |
| anything else, including unspecified | `"sdr"`, or the field left out |

The three HDR values are equivalent everywhere on this page: step 4 treats them alike, and the transfer used to convert pixels is the one the intermediate's frames report (H11), never the record's. The engine's own probe writes `"pq"`, `"hlg"` or `"sdr"`; the web host writes only `"hdr"`, for exactly the first three rows, and leaves the field out otherwise. A stream that is both Dolby Vision and PQ or HLG may be marked by either of its rows.

## The working space

**[H4] Working values.** A project composites in one of two domains, selected by the range of H2.

- **SDR (C3).** sRGB-encoded BT.709 R′G′B′, nominally 0 to 1. Every existing SDR project keeps its pixels: the record changes nothing in this domain.
- **HDR (C4).** Linear, display-referred light with BT.709 primaries and D65 white. Working value 1.0 is W cd/m² (203 by default), so a value v is v·W cd/m². Values above 1 are highlights. Negative values are colours outside BT.709 (up to BT.2020 and beyond) and are kept. Nothing is clamped until an explicit output conversion (H13, H14), apart from the clamps each effect page names.

In both domains alpha is straight (not premultiplied) and bounded to [0, 1]. Textures between stages are RGBA binary16, so each stage's result is rounded to binary16 and limited to ±65504. A conversion of this page changes RGB only: alpha passes through, clamped to [0, 1].

The domain is display-referred. An HLG source is converted to display light at a fixed nominal display (H7), not kept as scene light.

## Transfer functions and matrices

Stage vectors in the goldens pin each function below. They are defined in binary64, in the order written. See [Goldens](#goldens) for what a GPU implementation in binary32 must meet.

**[H5] sRGB curve, extended.** Both directions are odd functions, so they are defined for every real number. With a = |v|:

- SRGB⁻¹(v) = sign(v) · (a / 12.92 if a ≤ 0.04045, otherwise ((a + 0.055) / 1.055)^2.4)
- SRGB(v) = sign(v) · (12.92·a if a ≤ 0.0031308, otherwise 1.055·a^(1/2.4) − 0.055)

**[H6] PQ (SMPTE ST 2084).** m1 = 2610/16384, m2 = 2523/4096 × 128, c1 = 3424/4096, c2 = 2413/4096 × 32, c3 = 2392/4096 × 32. All five are exact binary fractions.

- PQ(L), for luminance L in cd/m²: y = clamp(L / 10000, 0, 1)^m1; PQ = ((c1 + c2·y) / (1 + c3·y))^m2.
- PQ⁻¹(E), for a signal E: e = clamp(E, 0, 1)^(1/m2); PQ⁻¹ = 10000 · (max(e − c1, 0) / (c2 − c3·e))^(1/m1).

PQ(10000) = 1 and PQ⁻¹(0) = 0 exactly. PQ(0) = c1^m2 ≈ 7.31 × 10⁻⁷, not zero, and PQ of a negative luminance is the same value.

**[H7] HLG (ITU-R BT.2100).** a = 0.17883277, b = 1 − 4a, c = 0.5 − a·ln(4a).

- OETF, scene light x to signal: e = clamp(x, 0, 1); HLG(x) = √(3e) if e ≤ 1/12, otherwise a·ln(12e − b) + c.
- Inverse OETF, signal E to scene light: e = clamp(E, 0, 1); HLG⁻¹(E) = e²/3 if e ≤ 0.5, otherwise (exp((e − c)/a) + b) / 12.
- System gamma for a nominal peak L_W: γ(L_W) = 1.2 + 0.42·log₁₀(L_W / 1000).
- OOTF, scene light (r, g, b) to display light in cd/m²: Y_S = max(0.2627r + 0.678g + 0.0593b, 0). If Y_S = 0 the result is (0, 0, 0). Otherwise each component is multiplied by L_W · Y_S^(γ − 1).
- Inverse OOTF, display light (r, g, b) in cd/m² to scene light: Y_D = max(0.2627r + 0.678g + 0.0593b, 0). If Y_D = 0 the result is (0, 0, 0). Otherwise y = (Y_D / L_W)^(1/γ), and each component is multiplied by 1 / (L_W · y^(γ − 1)).

The OOTF acts on luminance and scales the three components alike; it is not applied per channel. Black level is zero (no lift). Negative components pass through scaled, as long as the luminance is positive.

**Implementation-defined.** Every conversion of this page uses L_W = 1000 cd/m², so γ = 1.2, whatever the record says. Neither `masteringPeakNits` nor the display changes the HLG nominal peak. The goldens hold OOTF vectors at another peak only to pin the formula.

**[H8] Primaries.** Linear RGB is converted between BT.709 and BT.2020 with these matrices, applied to column vectors. Each output is (m₁·r + m₂·g) + m₃·b in that order.

| BT.709 → BT.2020 | | | BT.2020 → BT.709 | | |
| --- | --- | --- | --- | --- | --- |
| 0.627404 | 0.329282 | 0.043314 | 1.660491 | −0.587641 | −0.07285 |
| 0.069097 | 0.91954 | 0.011361 | −0.124551 | 1.1329 | −0.008349 |
| 0.016392 | 0.088013 | 0.895595 | −0.018151 | −0.100579 | 1.11873 |

**Implementation-defined.** These are the six-decimal coefficients of ITU-R BT.2087, used as they stand. The two matrices are not exact inverses, and the green row of the first sums to 0.999998, so working white (1, 1, 1) encodes with green about 2 × 10⁻⁷ below red and blue in the signal. A native client uses these coefficients, not recomputed ones.

A still supplied as a linear raster in Display P3 (H11) uses a third matrix, Display P3 (D65) → BT.709:

| | | |
| --- | --- | --- |
| 1.224940176 | −0.224940176 | 0 |
| −0.042056955 | 1.042056955 | 0 |
| −0.019637555 | −0.078636046 | 1.098273601 |

**[H9] Y′CbCr.** Decoded HDR video is BT.2020 non-constant-luminance Y′CbCr in limited range. For code values Y, Cb, Cr at bit depth n (n = 10 in production), with s = 2^(n − 8), K_R = 0.2627, K_B = 0.0593 and K_G = 1 − K_R − K_B:

- y = (Y/s − 16) / 219, p_b = (Cb/s − 128) / 224, p_r = (Cr/s − 128) / 224
- R′ = y + 2(1 − K_R)·p_r, B′ = y + 2(1 − K_B)·p_b, G′ = (y − K_R·R′ − K_B·B′) / K_G
- each of R′, G′, B′ is then clamped to [0, 1].

Code values below black, above white or outside the chroma range are not rejected: they take part in the arithmetic and the result is clamped. Full-range video is not converted (H11).

**[H10] HDR signal to working values.** For a non-linear BT.2020 signal (R′, G′, B′), a transfer and the reference white W:

1. Display light in cd/m², BT.2020: for PQ, PQ⁻¹ of each component. For HLG, HLG⁻¹ of each component, then the OOTF at L_W = 1000 on the triplet.
2. Divide each component by W.
3. Apply BT.2020 → BT.709 (H8).

Nothing is clamped after step 1: a saturated BT.2020 colour gives negative BT.709 components, and PQ signal 1.0 gives 10000/W, about 49.26 at the default white. PQ is absolute, so its light does not depend on any mastering metadata of the source; HLG is always shown at 1000 cd/m² nominal.

## Sources

**[H11] How sources enter a project.**

*SDR sources in an SDR project* are used as they are (C3).

*SDR sources in an HDR project.* Any 8-bit picture (an SDR video frame, a still, a text or vector snapshot) is decoded texel by texel with SRGB⁻¹ (H5) before any filtering, scaling or compositing; alpha is unchanged. SDR white therefore becomes working 1.0, the reference white: SDR is never expanded into the highlights. Authored colours (a shape's fill, gradient ends and stroke, and the canvas background, each byte / 255) are decoded the same way before they are interpolated. The engine receives SDR video as 8-bit R′G′B′ from the platform decoder and treats it as sRGB-encoded; that platform conversion is outside this page, as it is for SDR projects.

*HDR video in an HDR project.* The engine does not read the HDR original. It reads an intermediate the host supplies for it (10-bit BT.2020 PQ or HLG) and accepts a decoded frame only when all of these hold: 10-bit planar 4:2:0; transfer PQ or HLG; matrix BT.2020 non-constant-luminance; not full range; no rotation. A frame of any other layout is not converted: the source is unusable for that renderer and its item cannot be drawn (H16). For an accepted frame of W_f × H_f pixels, the chroma planes are ⌈W_f/2⌉ × ⌈H_f/2⌉ = C_w × C_h, and working pixel (i, j) is:

1. Y = the luma code at (i, j), read exactly.
2. Chroma at u = (i + 0.5)·(C_w/W_f) − 0.5, v = (j + 0.5)·(C_h/H_f) − 0.5: with x₀ = ⌊u⌋, y₀ = ⌊v⌋, f_x = u − x₀, f_y = v − y₀, the bilinear mix of the four codes at (x₀ + d_x, y₀ + d_y), d ∈ {0, 1}, each coordinate clamped to the plane. Cb and Cr are mixed as code values, before H9.
3. (R′, G′, B′) by H9 with n = 10, then working values by H10. Alpha is 1.

**Implementation-defined.** Step 2 places each chroma sample at the centre of its 2 × 2 luma block, whatever chroma location the stream signals. The frame's primaries are not inspected; BT.2020 is assumed. Static or dynamic HDR metadata of the source is not read.

*HDR stills.* The graph has no HDR still. A render worker may hand the renderer a still as an HDR raster keyed by `mediaId`, in one of two forms, and the project is then HDR (H3):

- A signal raster: opaque 16-bit full-range BT.2020 R′G′B′, PQ or HLG. Each code is divided by 65535, then H10 applies. Alpha is 1.
- A linear raster: binary32 RGBA, straight alpha, with a gamut (0 = BT.709, 1 = Display P3, 2 = BT.2020) and its own reference white W_r, where raster value 1.0 is W_r cd/m². RGB is converted to BT.709 by the matrix of its gamut (H8; none for gamut 0), then multiplied by W_r and divided by W. Alpha is kept.

A raster is admitted only if width and height are positive integers with width × height ≤ 48 000 000; a signal raster's transfer is PQ or HLG and it holds exactly 3 samples per pixel; a linear raster holds exactly 4 values per pixel, its gamut is 0, 1 or 2, W_r is a finite number in [1, 10000], every value is finite, every alpha is in [0, 1], and every colour value v has |v|·W_r ≤ 10000. Anything else is rejected with an error before rendering. Results are stored as binary16.

*HDR sources in an SDR project.* **Not implemented at this revision.** The engine has no per-source tone map, so this page has no rule that shows an HDR source inside an SDR project, and none is implied. The engine never inspects an original. What it does with a video whose original is HDR follows from two things it can see: the `colorTransfer` of the media record (H3), and whether the host has registered an intermediate for that media.

| Record | Intermediate | What the engine does |
| --- | --- | --- |
| marked `"pq"`, `"hlg"` or `"hdr"` | registered and accepted | The project is HDR (H3). The clip is ingested as HDR video, above. The transfer used is the one each decoded frame of the intermediate reports, not the record's. |
| marked | not registered, or it cannot be decoded, or its layout is not accepted | The project is HDR (H3). The item cannot be drawn and every frame that shows it is refused (H16). No SDR stream is substituted and nothing is tone-mapped. |
| not marked (no `colorTransfer`, or `"sdr"`) | not registered | The engine does not know that the original is HDR. The item contributes nothing to H3 and is an SDR source in every respect: the engine draws the 8-bit playback stream the host supplies, as it stands in an SDR project and through SRGB⁻¹ in a project that another source has made HDR, where its white lands on reference white. The tone map inside that stream is the server transcoder's. It is outside this page and no golden pins it. |
| not marked | registered | The web host does not produce this state: it registers an intermediate only for an original it marks in the same step. If it arises, H3 still counts nothing for the item, and the video is known to be HDR, so it is refused on the 8-bit route in any project (H16). In a project that another source has made HDR it is ingested from the intermediate. |

**Implementation-defined.** The web host marks a record when the server's report for a placed video arrives, not when the clip is placed. Between the two the third row holds, and on the first frame after the report the project becomes HDR (H3) and the first or second row holds. The same clip is therefore shown through the server's SDR stream first and as HDR, or refused, afterwards.

**Native rule.** Tone mapping an HDR source into an SDR project is undefined on this page, and no golden pins one. A native client avoids the case instead of rendering it:

1. *The client can read the transfer.* A client that reads the source itself takes the transfer characteristics of its picture stream (the code point of ITU-T H.273, from the codec's colour description or the container) and marks the media record when the clip is placed, by the mapping of H3. The project is then HDR from the first frame (H3), without the server, and the first or second row applies. It never decodes that source, or its intermediate, into an SDR project.
2. *The client cannot read the transfer.* Only then may it draw the server's SDR playback stream as an SDR source, as the third row does, until the server's report arrives and it marks the record.
3. *Platform conversion.* A platform conversion of an HDR source to SDR (a decoder or compositor asked for SDR output from PQ or HLG input tone-maps by its own rule) is allowed for one purpose only: a transient preview of a source whose record is not yet marked. The client tells the user that the picture is approximate, and it never uses such a picture for an export. In every other case the conversion is off.

A marked source without a usable intermediate is refused (H16), not shown from the SDR stream and not converted by the platform.

## Signal, scene light and display light

This section adds no rule. It states, for each stage above, which kind of value the stage takes, so that a native client knows which conversions of its platform decoder to turn off and which to apply itself.

- **Signal:** the non-linear values a stream carries, as Y′CbCr codes or as R′G′B′ in [0, 1].
- **Scene light** exists for HLG only: the linear, normalised result of HLG⁻¹, before the OOTF. Its scale is that of H7: HLG⁻¹(1) is 1 to within 3 × 10⁻⁸ (the constants of H7 are rounded).
- **Display light:** linear light at the display in cd/m². PQ⁻¹ gives it directly. HLG reaches it only through the OOTF. Working values (H4) are display light divided by W, in BT.709 primaries.

| Stage | Takes | Gives | HLG OOTF |
| --- | --- | --- | --- |
| H6, PQ⁻¹ | PQ signal | display light, cd/m², absolute | none: PQ has no OOTF on this page |
| H7, HLG⁻¹ | HLG signal | scene light, 0 to 1 | not yet applied |
| H7, OOTF | scene light, BT.2020 triplet | display light, cd/m² | this is it: L_W = 1000, γ = 1.2 |
| H9 and H11, video | Y′CbCr codes | R′G′B′ signal | none. Chroma is interpolated on codes, before the matrix and before any transfer function |
| H10 | R′G′B′ signal, BT.2020 | working values | inside step 1: after HLG⁻¹ and before the division by W and the primaries matrix, on BT.2020 components. Applied once, for HLG only |
| H11, signal raster | 16-bit R′G′B′ signal | working values, by H10 | as H10 |
| H11, linear raster | display light in its own gamut, 1.0 = W_r cd/m² | working values | none is applied. A supplier that holds HLG scene light applies the OOTF of H7 before it hands the raster over |
| H11, SDR texels | sRGB-encoded signal, display-referred | working values, by SRGB⁻¹ | none, and no other scene or display adjustment |
| H12, H13 | working values (display light) | SDR display signal | none |
| H14, PQ | working values (display light) | PQ signal | none |
| H14, HLG | working values (display light) | HLG signal | the inverse OOTF at L_W = 1000, applied once before the OETF. The signal is an ordinary HLG signal, and the encoder that receives it adds no OOTF |

So every ingest stage of H10 and H11 takes a **signal**, except the linear raster, which takes **display light**. No stage takes scene light from outside: scene light exists only between HLG⁻¹ and the OOTF inside H10, and between the inverse OOTF and the OETF inside H14.

**Native rule.** A platform decoder may hand a client the frame at any of the three points. Whichever it is, the working values must be those of H10 applied to the signal, and the client enters H10 as follows.

1. **Signal** (codes, or R′G′B′ not yet linearised): apply all of H10, and for planes H9 and the chroma rule of H11 first. Every transfer function, OOTF, tone map and gamut conversion of the platform is off. This is the only entry the `ingest/…` images pin from end to end.
2. **PQ as display light** (the platform has applied the inverse of PQ): enter H10 at step 2 with the light in cd/m². If the platform normalises its output, undo that first: a value where 1.0 stands for 10 000 cd/m² is multiplied by 10 000, and a value scaled to some reference white is multiplied by that white. The platform must not have limited the light by the source's mastering metadata or by the display.
3. **HLG as scene light** (the platform has applied HLG⁻¹ but no OOTF): apply the OOTF of H7 at L_W = 1000 to the BT.2020 triplet, then enter H10 at step 2. The scene light must be on the scale of H7, where signal 1.0 gives 1.0 to within 3 × 10⁻⁸; a platform whose scale runs to 12 is divided by 12 first.
4. **HLG as display light** (the platform has applied an OOTF of its own): this is H10 only if that OOTF is the one of H7, on luminance, with L_W = 1000, γ = 1.2 and zero black. A platform OOTF with another peak, another gamma or a per-channel form is turned off, and the client uses entry 3.

In every entry the OOTF is applied exactly once to HLG and never to PQ, the components stay in BT.2020 until step 3 of H10, and nothing is clamped after step 1. The Android implementation reports that Media3 hands PQ frames as display light and HLG frames as scene light: that is entry 2 for PQ and entry 3 for HLG, so its client applies the OOTF itself for HLG and adds none for PQ.

A platform that hands over R′G′B′ or light has already interpolated the chroma and applied the Y′CbCr matrix by its own rule. The chroma rule of H11 and the clamp of H9 are then the platform's, and the `ingest/video/…` images, which start from planes, do not apply to that path as they stand.

The `ingestLight` stage vectors hold one signal at each boundary: `sceneLight` (HLG only), `displayLight` and `working`. A client that enters at 2 feeds `displayLight` and must reach `working`; a client that enters at 3 feeds `sceneLight`.

## SDR display of an HDR project

**[H12] The EETF.** EETF(L, P, T) maps a luminance L in cd/m², mastered for a peak P, to a display of peak T:

1. If L ≤ 0 the result is 0.
2. If T ≥ P the result is min(L, T): nothing is compressed.
3. Otherwise m = PQ(P), E₁ = PQ(L) / m, M = PQ(T) / m and K = 1.5·M − 0.5.
4. E₂ = E₁. If E₁ > K and K < 1, then with t = (E₁ − K) / (1 − K): E₂ = (2t³ − 3t² + 1)·K + (t³ − 2t² + t)·(1 − K) + (−2t³ + 3t²)·M.
5. The result is min(PQ⁻¹(min(E₂, 1)·m), T).

This is the Hermite knee of Report ITU-R BT.2390 on PQ-encoded luminance: light below the knee start K is unchanged, and the source peak lands on the target peak with zero slope.

**Implementation-defined.** The black-level step of BT.2390 is absent (source and target black are 0). E₁ is normalised by dividing by PQ(P), without subtracting PQ(0). E₁ is not clamped to 1, so light above P follows the cubic beyond t = 1 and is then capped at T by step 5.

**[H13] SDR display.** This conversion produces what an SDR display shows: the preview canvas, an SDR video export, and an SDR still or signal frame. For a working pixel (r, g, b, α), with the values of H2:

- **SDR project:** each of r, g, b is clamped to [0, 1]. The values are already encoded. The policy is ignored.
- **HDR project, policy `none`:** each component v becomes 0 if v ≤ 0, 1 if v ≥ 1, and SRGB(v) (H5) otherwise. The two ends are selected, never computed, so they are exact. Light above reference white clips.
- **HDR project, policy `bt2390`:**
  1. Y = 0.2126r + 0.7152g + 0.0722b, on the linear working values. If Y ≤ 0, the pixel is converted as under `none`, ends included.
  2. L = Y·W. The display peak is T = 2W: one stop of room above reference white. E = EETF(L, P, T).
  3. k = (E / L) / 2. Multiply r, g and b by k.
  4. q = the largest of the three scaled components. If q > 1, divide all three by q.
  5. Encode each with SRGB, then clamp to [0, 1]. This step has no end rule: a scaled component of exactly 1 gives SRGB(1) as computed.

  Output alpha is clamp(α, 0, 1), and RGB stays straight.

**Implementation-defined.** SRGB(1) is not 1 when it is computed: 1.055 · 1 − 0.055 is 1 − 2⁻⁵³ in binary64 and 1 − 2⁻²⁴ in binary32. The policy `none` and the Y ≤ 0 case therefore give exactly 1 at and above reference white, while step 5 gives 1 − 2⁻⁵³ for a component that step 4 normalised to 1. "Clamp, then encode" is not the rule of `none`: in binary64 it gives 1 − 2⁻⁵³ where the rule gives 1. The engine's GPU stage, in binary32, does clamp and then encode, and on the canonical backend writes 1 − 2⁻²⁴ there; the image cases allow either, the stage vectors require the selection.

The tone curve is applied to BT.709 luminance, not per channel and not to the largest component, and the pixel's three components share one gain, so chromaticity is kept. Step 4 keeps the chromaticity of a saturated highlight that would otherwise clip in one channel. There is no gamut mapping: a negative component stays negative through steps 3 and 4 and becomes 0 in step 5.

With the defaults (W = 203, P = 1000, T = 406): the knee starts at about 257 cd/m²; reference white is unchanged by the curve, shows at 0.5 linear and encodes to about 0.7354; 812 cd/m² encodes to about 0.9993; the mastering peak and everything above it reach SRGB(1), one unit in the last place below 1.0. When P ≤ 2W the curve only caps at T.

**Implementation-defined.** The display peak is always twice the reference white; no property of the actual display is read. Reference white therefore shows at half the display's linear range in every HDR project.

## HDR delivery

**[H14] Working values to a PQ or HLG signal.** An export or scope request names its target: PQ, HLG or SDR display (H13). The project record does not choose it. For a pixel (r, g, b, α):

1. Linear BT.709 light: in an HDR project, (r, g, b) as they are. In an SDR project, SRGB⁻¹ of each component (H5), so SDR white is delivered at reference white.
2. Apply BT.709 → BT.2020 (H8). Clamp each component below at 0, then multiply by W: display light in cd/m².
3. **PQ:** PQ of each component (H6). Light above 10 000 cd/m² clips, per channel.
4. **HLG:** clamp each component above at 1000; apply the inverse OOTF at L_W = 1000 (H7) to the triplet; then HLG of each component.

The result is full-range non-linear BT.2020 R′G′B′ in [0, 1] with straight alpha clamp(α, 0, 1), in binary32. Colours outside BT.2020 and light above the transfer's peak are clipped here and nowhere earlier. No tone mapping is applied: an HDR project's highlights above 1000 cd/m² clip in HLG.

**[H15] What the engine does not define.** The engine's delivery output ends at the signal frame of H14. Quantisation, dithering, the R′G′B′ to Y′CbCr matrix, range, chroma subsampling, compositing over black and container signalling belong to the encoder that receives the frames, and the engine attaches no metadata: no MaxCLL, no MaxFALL, no mastering-display volume. `masteringPeakNits` is not written into any stream. Frameleaf's own master writer, which is outside the engine and outside this page, measures the content light level from the delivered PQ frames and takes the mastering display from the export request; an HLG master carries no static metadata. A native export follows the export contract for those, not this page.

## Refusals

**[H16] What is refused.** In an HDR project the engine renders a frame on the float route or not at all. It raises `HdrRenderUnavailableError` and draws nothing, and it never substitutes an 8-bit or SDR render, when:

- the float GPU compositor is unavailable;
- an item's blend mode is anything other than normal;
- a stack holds an enabled effect outside the 16 of C4;
- a transition is active, other than the one the engine has migrated (see the note below), or a nested composition contains any transition;
- an item cannot be drawn on the float route. This includes an HDR video whose intermediate is missing, cannot be decoded, or has a layout H11 does not accept;
- a layer mask cannot be rendered on the float route.

In any project, a video known to be HDR (its record says so, or the host has registered an intermediate for it) is refused on the 8-bit canvas route with a subclass of the same error.

Three failures are plain errors, not this class: a rejected raster (H11), a raster or a PQ or HLG signal frame requested without a GPU, and a signal frame whose composite could not be captured.

**Native rule.** A native client refuses the same frames: it reports that the frame cannot be rendered in HDR and shows or exports nothing for it. It does not fall back to SDR, does not skip the offending effect, blend or transition, and does not tone-map a source to work around a refusal.

**Note on transitions.** At this revision the engine renders one transition, additive dissolve, in an HDR project (`studio/additive-hdr-contract.md`), and refuses the other 43. T5 and the additive dissolve page still say that every transition is refused. Until those are reconciled, T5 governs a native client: refusing additive dissolve in HDR is safe, and rendering it is not yet specified here.

## Goldens

**[H17] Precision.** `goldens/hdr.json` holds two kinds of case, all with expected values produced by the engine.

- **Stage vectors** call the engine's colour functions directly, in binary64: the record resolution (H2), the source rule (H3), raster admission (H11), each function of H5 to H10 and H12 to H14, and H10 stopped at each of its boundaries ([Signal, scene light and display light](#signal-scene-light-and-display-light)). A case marked `exact` involves only addition, subtraction, multiplication, division, square roots, comparison and selection, and powers whose base is exactly 0 or 1 (IEEE 754 defines those results as exactly 0 and 1; the PQ end points rely on it); a native implementation in binary64 that follows the order written on this page reproduces it bit for bit. The other cases involve powers, logarithms or exponentials, whose last bits depend on the platform's mathematics library; they pass within max(10⁻¹², 10⁻⁹·|expected|) per number.
- **Images** push 16 × 12 pictures through the engine's GPU stages, which compute in binary32: the output conversion (H13, H14) for HDR and SDR projects, and the ingest of SDR texels, signal rasters, linear rasters and 10-bit video planes (H11). They are compared with `compareCase` of `README.md`. Their tolerances are measured: the canonical software GPU is compared with a hardware GPU and with a binary64 implementation of this page, and the bound is 1.5 times the largest difference, with a floor of half a 10-bit code value (0.0005) for a PQ or HLG signal, half an 8-bit code value for an SDR display, and 0.004 plus 0.2 % for working values. No case allows outliers.

**Implementation-defined.** Working values are stored as binary16, whose step is 0.0625 between 64 and 128 and 0.125 between 128 and 256. The ingest of PQ light near 10 000 cd/m² differs between the two GPUs by one such step, which is inside the 0.2 % relative bound.

Inputs are generated by formula in `../tools/hdr-goldens.mjs` and also stored. `working` is the linear HDR effect input of `README.md`; `encoded` is the SDR effect input; `bytes` is the SDR input as 8-bit RGBA; `signal16` is 257 times each RGB byte, an opaque 16-bit signal picture; `planes` is the same picture as 10-bit limited-range Y′CbCr 4:2:0, with four codes placed outside the nominal range.

Regenerate after an engine change, with the prepared engine served as `README.md` describes:

```sh
GOLDENS_CROSS_CHECK_ARGS='--enable-unsafe-webgpu --use-angle=metal --ignore-gpu-blocklist' \
  node studio/tools/hdr-goldens.browser.mjs --write   # canonical SwiftShader + a hardware cross-check
node studio/tools/hdr-goldens.browser.mjs             # drift gate
node --test studio/tools/hdr-goldens.test.mjs
```

| Stage name in the goldens | Rule |
| --- | --- |
| `resolve` | H2 |
| `sourceRange`, `timelineRange`, `decoderTransfer` | H3 |
| `srgbDecode`, `srgbEncode` | H5 |
| `pqEncode`, `pqDecode` | H6 |
| `hlgOetf`, `hlgInverseOetf`, `hlgSystemGamma`, `hlgOotf`, `hlgInverseOotf` | H7 |
| `bt709ToBt2020`, `bt2020ToBt709` | H8 |
| `ycbcrToSignal` | H9 |
| `signalToWorking` | H10 |
| `ingestLight` | H10 by boundary: `sceneLight` (HLG⁻¹ of each component; `null` for PQ), `displayLight` (the end of step 1, cd/m², BT.2020) and `working` |
| `rasterAdmission`, images `ingest/…` | H11 |
| `eetf` | H12 |
| `sdrDisplay`, images `output/…/sdr-display…` | H13 |
| `workingToSignal`, images `output/…/pq…` and `output/…/hlg…` | H14 |

## Gaps against the owner decision

These are the places where the engine or its host does something other than the sentence quoted at the top. None is changed by this page.

1. **The graph does not record that a project is HDR.** The rule of H3 runs at render time on media records. `metadata.colorManagement` is never written, so a reader of the graph alone sees an SDR project. The server's still-export check and the web export dialog read only the stored `workingRange`, and so treat an automatically HDR project as SDR: an HDR still export of it is refused.
2. **A stored `workingRange: "hdr"` is sticky.** It keeps a project HDR after its last PQ or HLG clip is removed. A stored `"sdr"` cannot keep a project SDR.
3. **The rule is not exactly "holds a PQ or HLG clip".** It is wider: the host marks any Dolby Vision original as HDR, an audio item that shares an HDR video's media counts, and a clip counts wherever it is on the timeline, visible or not. It is narrower: an export of a range that touches no HDR clip is SDR (H3), and nothing marks a still's media record, so a still makes a project HDR only as a render worker's raster.
4. **An HDR clip without its intermediate is refused, not tone-mapped.** Until the host has the 10-bit intermediate of a placed HDR original, frames that show that clip do not render (H16).
5. **The tone map is the engine's own BT.2390 variant** (H12, H13): no black-level step, a display peak fixed at twice reference white, a luminance gain followed by a largest-component normalisation, and no gamut mapping.
6. **`sdrMonitoring: "none"` clips.** A stored record can switch the SDR display of an HDR project from tone mapping to clipping, although the decision says an SDR display never clips. Nothing writes that value.
7. **The tone map applies to the composite, never to a source.** The engine has no rule for an HDR source in an SDR project (H11). A source whose record is not yet marked is shown through the server's SDR stream, with the server's tone map and not BT.2390, until the record is marked.

## Checks

- `node --test studio/tools/hdr-goldens.test.mjs` (engine-free, also run by `render-goldens.test.mjs`) verifies the structure and coverage of `goldens/hdr.json`, that the inputs match their formulas, that an independent implementation of this page reproduces every stage vector (bit for bit where marked exact) and every image within its tolerance, that no image case passes for another, and that this page holds no engine source text.
- `node studio/tools/hdr-goldens.browser.mjs` (needs the prepared engine and WebGPU; also run by `render-goldens.browser.mjs`) runs every case through the engine on the canonical backend and fails when one leaves its tolerance.
