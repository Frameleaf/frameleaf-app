# gpu-lut

| | |
|---|---|
| Category | color |
| Temporal | no |
| Pass | single fragment pass + 3D data texture N×N×N (8-bit RGBA), trilinear |
| HDR | refused |

## What it does
Applies a 3D colour lookup table that is embedded in the effect parameters. The table is imported from an Adobe/Resolve `.cube` file and stored as base64 RGBA8. The result is blended with the original by `intensity`.

## Parameters
| name | type | range | default | meaning |
|---|---|---|---|---|
| intensity | number | 0 .. 1 | 1 | blend amount (internally clamped to [0, 1] again) |
| lutName | json (string) | — | "" | display name only; no effect on pixels |
| lutSize | json (string or number) | — | "0" | table edge length N |
| lutData | json (string) | — | "" | base64 of N³·4 bytes |

`intensity` is sanitised per [C9]. If absent or not a number it means 1. The JSON fields pass through unchanged.

### Size resolution
1. raw = `lutSize`. A number is used as is. A string is converted with JavaScript `Number()` semantics: surrounding whitespace is ignored, `""` → 0, `"0x21"` → 33, and non-numeric text → NaN. Any other type → 0.
2. If raw is not finite, or raw < 2, or raw > 129, then N = 2 (identity fallback). Otherwise N = floor(raw).

### Table resolution
If N ≥ 2 and `lutData` is a non-empty string:
- Decode it as base64 using forgiving-base64 rules: standard alphabet, ASCII whitespace ignored, padding optional, and any invalid input is a failure.
- If decoding succeeds and the byte count is exactly N³·4, use those bytes.

In every other case (a decode failure, a wrong length, empty data) use the **2×2×2 identity table**. Its bytes are round(255·i/1) for i ∈ {0, 1}, i.e. 0 or 255 per axis.

Byte layout: entry (r, g, b) with integer indices 0…N−1 is at byte offset ((b·N + g)·N + r)·4. Red varies fastest, then green, then blue. Bytes 0–2 are the output R, G, B as value/255. Byte 3 is ignored. Texture axes: x = red index, y = green index, z = blue index.

The uniform size used by the shader is the N from *Size resolution*. It is not the size of the table actually bound (see Notes).

## Per-pixel definition
```
c0 = S(uv),  c = c0.rgb
N' = max(N, 2)
p  = clamp01(c) · (N' − 1)                       (per channel: position in table index units)
G  = trilinear interpolation of the table at p, clamp-to-edge   [C2]
     (with lo = floor(p), hi = min(lo + 1, N−1), f = p − lo per axis, red along x, green along y, blue along z)
out.rgb = c + (G − c)·clamp01(intensity)         (= mix(c, G, intensity))
out.a   = c0.a
```
When the bound table really is N³, the shader samples at texel-centre coordinates (p + 0.5)/N, so G is exactly the trilinear interpolation above.

## Edges
No image neighbourhood access. The table lookup cannot leave the table because the input is clamped to [0, 1].

## Alpha
Passed through unchanged. Table alpha is ignored.

## SDR and HDR
- SDR: the input is clamped to [0, 1] only for the lookup. The blend itself is not clamped. G is in [0, 1], and the result is stored per [C3].
- HDR: refused [C4]. The shader has an extended-range domain-offset term (add c − clamp01(c) to G), but it is unreachable.

## Import (authoring side, CPU)
This describes how the Studio UI turns a `.cube` file into the parameters above. A native client that imports `.cube` files must do the same to produce identical projects.

**Parsing.** Split the file into lines (LF or CRLF) and trim each one. Skip empty lines and lines starting with `#`. Then, in file order:
- `TITLE "x"` → title x. A TITLE line without quotes takes the rest of the line, trimmed.
- `LUT_1D_SIZE` → error (1D LUTs are unsupported).
- `LUT_3D_SIZE n` → the integer prefix of n (parseInt), which must be in 2..129, otherwise error. This allocates the table.
- `DOMAIN_MIN a b c` / `DOMAIN_MAX a b c` → three floats (default 0 0 0 / 1 1 1). Each takes effect for data lines that come *after* it.
- Any other line starting with a letter is ignored.
- A line starting with a digit, `-`, `+` or `.` is a data line:
  - It is an error if it comes before `LUT_3D_SIZE`, if it would exceed N³ entries, if it has fewer than 3 whitespace-separated tokens, or if a token is non-numeric. Tokens use parseFloat, so a numeric prefix is accepted.
  - Each channel value v becomes byte round(clamp01((v − min_c)/(max_c − min_c))·255) using that channel's current domain. If max_c = min_c the byte is 0.
  - Entries fill the table in file order, red fastest.
- The data count must equal N³ exactly, otherwise error.

**Resampling.** If N > 33 the table is resampled to 33³:
- scale = (N−1)/32;
- every destination index d maps to source position d·scale per axis;
- trilinear interpolation of the source *bytes* (lo = min(floor, N−1), hi = min(lo + 1, N−1)), in float64;
- each result is rounded half-up to a byte.

**Stored parameters.** lutName = TITLE, or the file name with a trailing `.cube` (any case) removed. lutSize = decimal string of the final N. lutData = base64 of the bytes.

## Notes
- Implementation-defined: `DOMAIN_MIN`/`DOMAIN_MAX` are used to normalise the table's *output* values into bytes. They are not used as an input domain, which differs from the `.cube` convention, where the domain describes the input. Values outside the domain are clipped at import. The per-pixel lookup always treats the input domain as [0, 1].
- Implementation-defined: if `lutSize` is valid (say 33) but `lutData` is missing or invalid, the bound table is the 2³ identity while the shader still uses N = 33. The texture coordinate (clamp01(c)·32 + 0.5)/33 is then applied to a 2-texel axis, giving
  `out = clamp01(2·(clamp01(c)·(N−1) + 0.5)/N − 0.5)` per channel (before the intensity blend).
  This is close to, but steeper than, the identity. When N resolves to 2, the identity is exact.
- Output is quantised to 8 bits per entry. Hardware trilinear filtering has limited weight precision, so allow about ±1/255 (2/255 for steep LUTs).
- A separate execution-only effect, `gpu-file-lut-v1` (float table, arbitrary input domain), exists in the engine. It is not part of this effect and is not covered here.
- No transcendental functions.
