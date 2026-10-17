# gpu-curves

| | |
|---|---|
| Category | color |
| Temporal | no |
| Pass | single fragment pass + data texture 256×1 (8-bit RGBA, CPU-baked) |
| HDR | refused |

## What it does
Per-channel tone curves. A master curve is applied first, then a red, green or blue curve. Each curve is a monotone cubic through control points. The combined transfer per channel is baked into a 256-entry table that the shader looks up.

## Parameters
| name | type | range | default | meaning |
|---|---|---|---|---|
| {ch}ShadowX | number | 0 .. 1 | 0.25 | 2-point mode: shadow point x |
| {ch}ShadowY | number | 0 .. 1 | 0.25 | 2-point mode: shadow point y |
| {ch}HighlightX | number | 0 .. 1 | 0.75 | 2-point mode: highlight point x |
| {ch}HighlightY | number | 0 .. 1 | 0.75 | 2-point mode: highlight point y |
| {ch}Points | json (string) | — | "" | multi-point mode; overrides the four numbers for that channel |

`{ch}` ∈ {master, red, green, blue}, giving 16 numbers + 4 JSON strings. Numbers are sanitised per [C9]. JSON passes through unchanged.

### Control points per channel (CPU)
Each channel resolves to a point list P in this order of precedence:

1. **Multi-point.** Use this if `{ch}Points` is a non-empty string that parses as JSON and meets all of these conditions:
   - it is an array;
   - every element is an array of length ≥ 2 whose first two items are numbers (as `[x, y]`; extra items are ignored);
   - there are at least 2 elements.

   Any other value (bad JSON, a wrong shape, fewer than 2 entries) falls through to step 2. The parsed points are then cleaned:
   1. Drop non-finite points.
   2. Clamp x and y to [0, 1].
   3. Sort by x (stable).
   4. Keep the first 16.
   5. Walk the list in order and drop a point when its x minus the x of the last *kept* point is < 0.02.
   6. If fewer than 2 points remain, P = [(0,0), (1,1)].
2. **Two-point.** Use this if at least one of the channel's four numeric keys is **present** in the stored parameter object. Sanitising [C9] has already run: a key that is present but is not a finite number (a string, `null`, a boolean) has become its default (0.25 for a shadow key, 0.75 for a highlight key), and it counts as present. So four keys that are present but not finite draw the default two-point curve, which is the identity (`gpu-curves/sdr/master-keys-not-finite`), and one finite key among three that are not draws that key with the other three at their defaults (`…/master-one-finite-key`).
   1. Read shadow = (ShadowX, ShadowY) and highlight = (HighlightX, HighlightY). A key that is absent while another of the four is present means 0.25 for shadow, 0.75 for highlight.
   2. Clamp both x values to [0.02, 0.98].
   3. If shadow.x > highlight.x, swap **only the two x values**. The y values stay with their original names. This is implementation-defined but observed.
   4. If highlight.x − shadow.x < 0.04, let m = clamp((shadow.x + highlight.x)/2, 0.04, 0.96). Set shadow.x = m − 0.02 and highlight.x = m + 0.02.
   5. Clamp both y values to [0, 1].
   6. P = [(0,0), shadow, highlight, (1,1)].
3. **Legacy.** Use this only when all four keys are **absent** from the stored object. It applies to old projects (`gpu-curves/sdr/master-keys-absent-legacy`, `…/red-keys-absent-legacy`). "Present but not finite" never reaches it.
   - Master: the shadow point is (0.25, L(0.25)) and the highlight point is (0.75, L(0.75)). The undeclared parameters `shadows`, `midtones`, `highlights` and `contrast` are each divided by 100 (a missing or non-finite value counts as 0), giving sh, mi, hi and ct. L(v) applies these steps in order:
     1. v += (1−v)²·sh·0.5
     2. v += 4v(1−v)·mi·0.25
     3. v += v²·hi·0.5
     4. v = (v−0.5)(1+ct)+0.5
     5. clamp01
   - Red, green, blue: o = clamp(p/200, −0.5, 0.5), where p is the undeclared parameter `red`, `green` or `blue` (missing counts as 0). The points are (0.25, 0.25+o) and (0.75, 0.75+o).
   - Both then go through the two-point cleaning above.

### Curve evaluation f_P(x) (CPU, float64)
1. **Normalise P.**
   - If P is empty, P = [(0,0), (1,1)].
   - Clamp x and y to [0, 1] and sort by x.
   - Walk the list and keep a point only if its x differs from the previous kept x by > 0.0005.
   - Start: if the first x > 0.0001, prepend (0, y_first); otherwise set the first x to 0.
   - End: if the last x < 0.9999, append (1, y_last). A last x in [0.9999, 1] is kept as it is.
2. **Edges.** Let x' = clamp01(x). If x' ≤ x_0, return y_0. If x' ≥ x_last, return y_last. Outside the points the curve is flat.
3. **Find the segment.** Take the first segment i with x_i ≤ x' ≤ x_{i+1}.
4. **Tangents.** These are recomputed from the full normalised list, with n points:
   - slopes: s_k = (y_{k+1}−y_k) / max(1e‑6, x_{k+1}−x_k)
   - endpoints: m_0 = s_0 and m_{n−1} = s_{n−2}
   - interior points: m_k = 0 if s_{k−1}·s_k ≤ 0, otherwise (s_{k−1}+s_k)/2
   - Fritsch–Carlson limiter, run sequentially for k = 0 … n−2, updating the m values in place (a later k sees the m_{k} written at step k−1):
     - if |s_k| < 1e‑6, set m_k = m_{k+1} = 0;
     - otherwise let a = m_k/s_k and b = m_{k+1}/s_k. If a²+b² > 9, let τ = 3/√(a²+b²) and set m_k = τ·a·s_k and m_{k+1} = τ·b·s_k.
5. **Hermite.** Let w = max(1e‑6, x_{i+1}−x_i) and t = clamp01((x'−x_i)/w). Then
   y = (2t³−3t²+1)·y_i + (t³−2t²+t)·w·m_i + (−2t³+3t²)·y_{i+1} + (t³−t²)·w·m_{i+1}.
   Return clamp01(y).

### Table bake
For k = 0 … 255:
- x = k/255
- M = f_master(x)
- T_r[k] = round(clamp01(f_red(M))·255) / 255. The same applies to green and blue.

`round` is round-half-up (JavaScript `Math.round`). The table is stored as 8-bit unorm.

## Per-pixel definition
```
c = S(uv)
for each channel ch in {r, g, b}:
    p = clamp01(c.ch) * 255                   (table position, 0..255)
    k0 = floor(p), k1 = min(k0 + 1, 255), f = p - k0
    y_ch = T_ch[k0] + (T_ch[k1] - T_ch[k0]) * f
out.rgb = (y_r, y_g, y_b)
out.a   = c.a
```
This is exactly what the shader's bilinear sample at u = (p + 0.5)/256 returns [C2]: the lookup hits texel centres, so the endpoints are exact. Each output channel reads only its own column of the table.

## Edges
No neighbourhood access in the image. The table lookup cannot fall outside it because the input is clamped to [0, 1].

## Alpha
Passed through unchanged. The table's alpha is ignored.

## SDR and HDR
- SDR: inputs are clamped to [0, 1] for the lookup. The output is in [0, 1] by construction. There is no further clamp.
- HDR: refused [C4]. The shader contains an extended-range "domain offset" term (add back c − clamp01(c)), but it is unreachable because the engine refuses this effect in HDR.

## Notes
- Implementation-defined: the table is 8-bit, so every curve is quantised to steps of 1/255 before interpolation.
- Hardware bilinear filtering uses limited sub-texel weight precision (often 8 bits). Allow about ±1/255 against a float implementation.
- With catalogue defaults the result is the identity curve within 8-bit quantisation, which is exact at the 256 sample points.
- Legacy mode is reachable only when a channel's four numeric keys are absent from the stored parameters (sanitising does not insert missing keys).
- If the table bake throws, the engine keeps the previous table for this pass if one exists, otherwise it skips the effect. This should not happen for valid inputs.
- No transcendental functions.
