# Bounded photometric numerical contract (FL-97 / FL-100)

These eight authored HDR cases qualify only four existing GPU nodes. Hosted
execution remains required. The CPU fixture tests validate the aggregate checker;
they are not renderer evidence. No observed GPU pixels supply expected values.

The immutable original is Freecut revision
`4d62e8082c5eb387a96275bcbd323d28f6e41a62`, archive SHA-256
`b4224e5c219a6302586cbe2242e9e6d299dfd1878f1fcd0f2d77ea3db12a5d32`.
Selected original `src/infrastructure/gpu-effects/effects/color.ts` has SHA-256
`a07fef170d8d9d2b1a2588e2494dadd7111d89fdaf93d0c530c5e567bf63cfcb`.
It was read statically with `tar -xOf`; no local patch application, preparation
or source generation occurred. The adapted file differs from this original.

All patches touching `color.ts` were inspected: 0027 adds the clock import and
changes Hue Shift only (SHA-256
`36f9b02ccb9cefcb51367ff1102146b9daef37c6f4daef6f9d360cc363f77951`);
0031 changes the four selected shaders as shown below, alongside unrelated
color nodes (SHA-256
`8a4da43e50c4f59391dc7b443818e2cd7e03488150877e4d18c4bac824f02068`).
Original selected definitions and uniform packing plus every corresponding
patch hunk bind the equations. This is a static original-plus-patch contract,
not a claim that original and adapted bytes are identical.

The genuine b937 inventory from hosted run `37166453100` (producer
`b937340639e950f3d2c7811ae1832d52a1a0c7b4`, tree
`75d7b6cc1e8095a1ae632bbe7a52722f80ce4324`) has SHA-256
`6556fc1c946a320ca08989eef692652d275af5cdd3124f7ddb8e619196d7a542`.
Its selected per-file hashes match the genuine 1b8 inventory:

| Adapted path under `src/infrastructure/gpu-effects` | SHA-256 |
| --- | --- |
| `effects/color.ts` | `53e8a9b6c748a9c04bfa02edad3d068e14872c5ff9652912ec42e1d6e8e85d5c` |
| `common.ts` | `e8ae09970e48879996b7f64ee6daa9bdd822cb66233ca374adb9ad65a996a349` |
| `effects-pipeline.ts` | `edbaa7a91f8966ba942cfa7c10eeaf5342fd8d583066be2f2800bcc6431d7374` |

These are inventory receipts, not locally available complete adapted source.
The hosted matrix hashes the actual prepared files and refuses numerical
qualification on any mismatch. The receipt does not prove execution. The entire
source digest is not pinned here because approved unrelated policy edits change
it. Existing source admission and browser dispatch remain mandatory.

Let `R(x)=clamp(x,-65504,65504)` and `P(x,g)=sign(x)*abs(x)^(1/g)`.
0031 supplies both helpers, selecting signed range only when format is
`rgba16float` and `workingRange==='hdr'`; other routes retain SDR clamps.
The pipeline keys both range and format, injects these helpers and draws the
selected effect shader. Each selected shader returns the original `color.a`.

| Node | Independent RGB equation | Authored parameter cases |
| --- | --- | --- |
| `gpu-brightness` | `R(c+amount)` | amount +.125 and -.125 |
| `gpu-contrast` | `R((c-.5)*amount+.5)` | amount 1.5 and .75 |
| `gpu-exposure` | `R(P(c*2^exposure+offset,gamma))` | (1,.125,2) and (-1,-.125,.75) |
| `gpu-levels` | `R(outputBlack+(outputWhite-outputBlack)*P(R((c-inputBlack)/safeSpan),gamma))` | (.25,.75,1,.125,.875) and (.125,.875,2,0,1) |

For levels `span=inputWhite-inputBlack` and `safeSpan=span` except when
`abs(span)<1e-4`, when it is signed `1e-4` (zero uses positive sign).
Both cases have a positive noncollapsed span. Collapsed and reversed ranges
remain unqualified: the current shader's epsilon scaling in HDR differs from
the ledger wording “hard threshold”; this packet neither changes that behavior
nor treats the wording as evidence.

Each case uses the same separate 8x4 signed RGB ramp with exactly representable
binary16 input and alpha, including hidden RGB at alpha zero and translucent
fractions. Actual `EffectsPipeline.applyTextureEffectsToTexture` results must
match all 128 channels per case: exactly eight unique ordered parameter cases,
1024 mandatory channels, RGB tolerance `max(.004,abs(expected)*.002)` for f32
arithmetic/pow plus binary16 storage, alpha tolerance `1e-6`. No picture input
quantization allowance is needed for these binary values.

Every case must have negative and above-white expected channels and strong
discriminators against identity, negative clipping and white clipping. Exposure
and levels additionally discriminate unsigned gamma. The aggregate rejects
missing cases, refusal, partial arrays, nonfinite pixels and every numerical
mismatch. Focused synthetic tests exercise this same aggregate with each wrong
answer, without any mock production renderer or copied GPU baseline.

Curves interpolation and LUT domains, the other 50 registered nodes, parameter
interactions/animation goldens, collapsed/reversed levels semantics, Canvas and
non-GPU fallback paths, physical GPU devices, actual Firefox/Safari backend
execution and HDR display/device acceptance remain open. This packet does not
complete FL-97 or FL-100 or establish physical HDR output proof.
