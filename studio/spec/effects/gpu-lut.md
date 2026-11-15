# gpu-lut

| | |
|---|---|
| Category | color |
| Temporal | no |
| Pass | single fragment pass + 3D data texture N×N×N (8-bit RGBA), trilinear |
| HDR | refused |

## What it does
Applies a colour lookup table, blended with the original by `intensity`. The table is either embedded in the effect parameters (a 3D table imported from an Adobe/Resolve `.cube` file and stored as base64 RGBA8) or a `.cube` file kept with the project, which the effect names by id (see *LUTs kept with the project*; FL-1558). A kept file may be a 3D or a 1D table.

## Parameters
| name | type | range | default | meaning |
|---|---|---|---|---|
| intensity | number | 0 .. 1 | 1 | blend amount (internally clamped to [0, 1] again) |
| lutName | json (string) | — | "" | display name only; no effect on pixels |
| lutSize | json (string or number) | — | "0" | table edge length N |
| lutData | json (string) | — | "" | base64 of N³·4 bytes |

| lutId | json (string) | — | absent | id of the project import that holds the `.cube` file (a reference) |
| lutSource | json (string) | — | absent | `"import"` for a file kept with the project |

`intensity` is sanitised per [C9]. If absent or not a number it means 1. The JSON fields pass through unchanged. `lutId` and `lutSource` are not in the parameter catalogue's defaults: an effect without them is embedded, and the rest of this page up to *LUTs kept with the project* describes it.

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

## LUTs kept with the project
An effect whose `lutSource` is `"import"` and whose `lutId` is a non-empty string is a **reference**. Its table is the `.cube` file the project keeps under that id (a project import of kind `lut`; the server resolves the reference as resource kind `lut` with `lutSource: "import"`). A reference carries `lutSize` `"0"` and `lutData` `""`, so the embedded fields alone describe the 2×2×2 identity; `lutName` is the file's TITLE, or its file name without `.cube`, for display only. Every clip graded with the same file names the same id, and the file is stored once. Any other `lutSource`, or an empty `lutId`, is not a reference.

**Reading the file.** The bytes are UTF-8 text. They are refused, not guessed at, unless they are exactly one of the two forms below (the grammar the server applies when the file is imported). Lines split on LF, CRLF or CR and are trimmed; empty lines and lines starting with `#` are skipped; no line may be longer than 250 characters, and no control character other than tab, LF and CR may appear. A line starting with a keyword is a header line; every other line is a row of exactly three decimal numbers (sign, digits, optional fraction and exponent; finite and at most 10³⁷ in magnitude). Header lines must all come before the first row.
- `TITLE` once, with a non-empty value; quotes around it are removed.
- Exactly one of `LUT_3D_SIZE n` (n from 2 to 65; the table has n³ rows, red fastest, then green, then blue) and `LUT_1D_SIZE n` (n from 2 to 65 536; the table has n rows, entry i holding the outputs of the three channels at position i).
- `DOMAIN_MIN a b c` and `DOMAIN_MAX a b c` at most once each: the **input** domain per channel. Defaults 0 0 0 and 1 1 1.
- At most one input range: `LUT_3D_INPUT_RANGE lo hi` on a 3D file or `LUT_1D_INPUT_RANGE lo hi` on a 1D file, lo < hi. It sets all three domain bounds and must agree exactly with any DOMAIN line.
- Each channel's span max − min, computed in binary32, is positive and its reciprocal is finite.
- Any other keyword, a row count other than the size requires, or both sizes refuses the file.

Unlike the embedded import, the outputs are kept exactly as written (binary32), outside [0, 1] included, and the domain describes the input, as the `.cube` convention says.

**3D file.** With size n, domain [min, max] and entries E(r, g, b):
```
u   = clamp01((c − min) / (max − min))          (per channel)
p   = u · (n − 1)
lo  = floor(p),  hi = min(lo + 1, n − 1),  f = p − lo   (per axis)
G   = trilinear interpolation of E between lo and hi with weights f, red along x, green along y, blue along z
out.rgb = c + (G − c) · clamp01(intensity)
out.a   = c0.a
```
The entries are read exactly (no texture filtering) and interpolated as binary32 values.

**1D file.** With n entries E(i) = (R(i), G(i), B(i)) and the domain, each channel k of r, g, b is looked up in its own column:
```
u_k   = clamp01((c_k − min_k) / (max_k − min_k))
p_k   = u_k · (n − 1)
lo_k  = floor(p_k),  hi_k = min(lo_k + 1, n − 1),  f_k = p_k − lo_k
L_k   = E_k(lo_k) + (E_k(hi_k) − E_k(lo_k)) · f_k
out.rgb = c + (L − c) · clamp01(intensity)
out.a   = c0.a
```
Example: entries (0, 1, 0), (0.25, 0.5, 0.1), (1, 0, 1) with the default domain map the input (0.25, 0.75, 0.625) to (0.125, 0.25, 0.325).

**Timing.** Preview draws a reference as the identity until its file has been read, then redraws. An export, or any render that must match it, reads every referenced file before the first frame and is refused if one is missing or invalid; it never renders that clip ungraded. A native client follows the export rule.

**HDR.** As for the embedded table: refused [C4].

## Notes
- Implementation-defined: `DOMAIN_MIN`/`DOMAIN_MAX` are used to normalise the table's *output* values into bytes. They are not used as an input domain, which differs from the `.cube` convention, where the domain describes the input. Values outside the domain are clipped at import. The per-pixel lookup always treats the input domain as [0, 1].
- Implementation-defined: if `lutSize` is valid (say 33) but `lutData` is missing or invalid, the bound table is the 2³ identity while the shader still uses N = 33. The texture coordinate (clamp01(c)·32 + 0.5)/33 is then applied to a 2-texel axis, giving
  `out = clamp01(2·(clamp01(c)·(N−1) + 0.5)/N − 0.5)` per channel (before the intensity blend).
  This is close to, but steeper than, the identity. When N resolves to 2, the identity is exact.
- Output is quantised to 8 bits per entry. Hardware trilinear filtering has limited weight precision, so allow about ±1/255 (2/255 for steep LUTs).
- The engine renders a reference through two execution-only effects that no graph may name, `gpu-file-lut-v1` (3D) and `gpu-file-lut-1d-v1` (1D). *LUTs kept with the project* is their contract. The browser goldens cover the embedded table only; the 1D formula is pinned by engine-free reference tests (`cube-file.test.ts`).
- No transcendental functions.
