# gpu-gradient-map

| | |
|---|---|
| Category | color |
| Temporal | no |
| Pass | single fragment pass + data texture 256×1 (8-bit RGBA, CPU-baked) |
| HDR | refused |

## What it does
Maps each pixel's Rec.601 luma through a colour ramp (a preset palette or custom hex stops), then blends the result with the original.

## Parameters
| name | type | range | default | meaning |
|---|---|---|---|---|
| preset | select | inferno, magma, plasma, viridis, turbo, fire, ice, sunset, grayscale, custom | inferno | palette |
| customStops | text | — | "#000004, #420a68, #932667, #dd513a, #fca50a, #f0f921" | stops used when preset = custom |
| mix | number | 0 .. 1 | 1 | blend amount (internally clamped to [0, 1] again) |

Sanitised per [C9]. An unknown preset becomes `inferno`. If `mix` is absent it means 1. If `preset` is absent it means `inferno`. If `customStops` is absent it means the empty string, **not** the catalogue default (see Notes).

### Preset stops (dark → light)
| preset | stops |
|---|---|
| inferno | #000004 #420a68 #932667 #dd513a #fca50a #f0f921 |
| magma | #000004 #3b0f70 #8c2981 #de4968 #fe9f6d #fcfdbf |
| plasma | #0d0887 #6a00a8 #b12a90 #e16462 #fca636 #f0f921 |
| viridis | #440154 #3b528b #21918c #5ec962 #fde725 |
| turbo | #30123b #4675ed #1bcfd4 #a4fc3b #fe9b2d #cb2a04 #7a0403 |
| fire | #000000 #7a0000 #ff4800 #ffd000 #ffffff |
| ice | #000010 #003b6f #1b78c2 #7ec8ff #ffffff |
| sunset | #241634 #c2456b #ffd9a0 |
| grayscale | #000000 #ffffff |

### Custom stops parsing
1. Split `customStops` on `,`, trim surrounding whitespace from each piece, and drop empty pieces.
2. Each piece must start with `#`. A 3-digit form `#rgb` is expanded to `#rrggbb`. After expansion it must be exactly 6 hex digits (either case).
3. Each parsed stop is (RR/255, GG/255, BB/255).
4. A piece that fails (wrong length such as 4 or 8 digits, a non-hex character, no `#`) is **kept as black (0,0,0)**, not dropped.
5. If there are zero stops, use [black, white]. If there is one stop s, use [s, s].

### Table bake
n = number of stops (≥ 2) and seg = n − 1. For k = 0 … 255:
```
t = k/255,  x = t·seg
i = min(floor(x), seg − 1),  f = x − i
T[k] = round((A_i + (A_{i+1} − A_i)·f) · 255) / 255        (per channel, round = round-half-up)
```
This is computed in float64 and stored as 8-bit unorm. Stops are evenly spaced, and stop j sits at t = j/seg.

## Per-pixel definition
```
c0 = S(uv),  c = c0.rgb
L = clamp01(LUMA601(c))
q = L·256 − 0.5                                  (table position)
k0 = clamp(floor(q), 0, 255),  k1 = clamp(floor(q) + 1, 0, 255),  f = q − floor(q)
M = T[k0] + (T[k1] − T[k0])·f                    (bilinear at u = L, clamp-to-edge [C2])
out.rgb = c + (M − c)·clamp01(mix)               (= mix(c, M, mix))
out.a   = c0.a
```

## Edges
No image neighbourhood access. The table lookup uses clamp-to-edge.

## Alpha
Passed through unchanged. The table's alpha (always 1) is ignored.

## SDR and HDR
- SDR: no clamp. M is in [0, 1], and c is the input. The result is stored per [C3].
- HDR: refused [C4].

## Notes
- Implementation-defined (the half-texel offset): unlike gpu-curves, the lookup uses u = L directly rather than mapping L to texel centres. The table is therefore read at position 256·L − 0.5 instead of 255·L. Consequences:
  - L ≤ 0.5/256 returns T[0];
  - L ≥ 255.5/256 returns T[255];
  - in between, the ramp is stretched by 256/255 around L = 0.5, which maps exactly to the midpoint of T[127] and T[128].
  
  A native port must reproduce this to match.
- Implementation-defined: a missing `customStops` key with preset = custom gives a black→white ramp. The catalogue default only applies when the key holds that string.
- A `customStops` value that is not a string makes the table bake fail. The engine then reuses this pass's previous table if one exists, otherwise it skips the effect.
- 8-bit table and hardware bilinear weight precision: allow ±1/255.
- No transcendental functions.
