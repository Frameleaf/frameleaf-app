# FL-97 managed color qualification

This ledger describes authored coverage, not measured conformance. FL-97 remains
open. FL-107's explicit PQ/HLG conversion and native HDR master requirements are
preserved. A passing software-backend run does not qualify physical devices.

## Mixed source packet (October 3, 2026)

`tools/hdr-source.browser.mjs` now places both real decoded AV1 PQ and HLG
intermediates and an SDR graphic in one composition. Three signal segments
exercise reference light, highlights, and colored wide-gamut input. Each HDR
region traverses its own exposure effect and translucent source-over blend with
an SDR background, then both explicit PQ and HLG outputs. Goldens derive from
actual decoded Y'CbCr planes using the managed-color CPU reference, rather than
assuming a lossy encode preserved its input exactly. Assertions require a signed
working-RGB input, above-white composite values, and a measurable difference
from premature source clipping. The SDR region checks deliberate reference-white
mapping. All regions have opaque output alpha because of the background.

The existing Studio engine workflow runs this file. No local browser, build,
runtime, preparation, generation, or test execution was performed for this
packet. Hosted execution, immutable-source replay, and raw measurement evidence
remain pending. No prepared engine source artifact was available to this owner;
the packet changes regression coverage and does not claim a production correction.

## Remaining acceptance matrix

| Graph path | Existing coverage | Remaining qualification |
| --- | --- | --- |
| Effects / curves / LUTs | Effects matrix and declared HDR semantics | Per-node numerical ramps and signed/extended golden coverage beyond finite/range checks; imported LUT domains |
| Blends | Blend matrix and signed soft-light transport | Full premultiplied-alpha edge goldens on supported hardware |
| Transitions / nested Compose | Float and transition matrices; nested float regression | Mixed real sources through nested, masked, and fallback paths |
| Masks | Allocation sites declared | HDR participant keeps float or explicitly refuses every Canvas2D fallback; mask edge goldens |
| Non-GPU effects | Legacy fallback sites declared | Real HDR source keeps float or refuses each Canvas2D effect path |
| Text | Deliberate SDR graphic input | Numerical HDR reference-white and alpha-edge goldens |
| Lottie | Deliberate SDR graphic input | Real Lottie HDR reference-white golden with admitted resources |
| Mixed SDR/PQ/HLG | This authored decoded-source / exposure / alpha / output packet | Hosted execution; overlapping sources, nested graph and complete delivery goldens |
| Allocation and readback | Declared allocation audit and software readback regressions | Prove HDR cannot reach every declared 8-bit fallback; cross-backend precision |
| FL-107 output | Explicit output and HDR master regressions retained | Hosted exact-candidate evidence, encoded metadata and actual device HDR playback |

GitNexus query found the regression file but not `createCompositionRenderer` or
`renderFrameSignal`; engine call-graph risk is **UNKNOWN**. The isolated checkout
has no current index, and indexing is outside this packet's authority. Manual
scope review limits changes to the regression and this ledger.

Physical Vulkan/D3D12/Metal backend coverage, HDR displays and actual playback
devices remain acceptance gates. FL-87's licensed Dolby toolchain, owned specimens,
and device evidence remain dependencies; this packet neither substitutes for
them nor changes media/resource rights admission or original-media authority.
