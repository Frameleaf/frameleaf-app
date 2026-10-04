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

## Nested mask and alpha packet (October 3, 2026)

The same hosted HDR-source regression now puts each real decoded PQ/HLG source
through a functional upper-half alpha mask and two nested compositions. An SDR
graphic sits above the mask track: it blends over HDR where the mask includes
the video and remains visible where the mask excludes it. The inner instance
scales into the right half of the outer transparent viewport. Root opacity is
0.5, and five quarter-pixel translations create an alpha-coverage ramp across
the viewport edge. Independent decoded-plane references and source-over algebra
define six sample points for every segment, translation and output policy.
Signed and above-white contributions remain mandatory; clipping and interpolation
without premultiplied-alpha weighting must produce distinguishable counterfactuals.
These 60 frame cases require preservation. A refusal cannot pass their goldens.

A separate masked 16-bit HDR raster transition records a **diagnostic-unqualified**
result. If it renders, independent signal goldens are mandatory. If it refuses,
only an actual `Error` with one of patch 0043's exact HDR-raster refusal messages
is recorded; unrelated exceptions fail. Partial emitted signals remain in its
report. No authoritative current supported-float versus forced-Canvas capability
discriminator was available, so neither outcome qualifies fallback reachability.
Every emitted output is numerically validated even if a later policy refuses;
only complete two-policy output is conditional on the preserved status. A focused
hosted report-validator regression checks corrupt/nonfinite earlier output,
valid partial output remaining unqualified, and complete preserved output. These
report fixtures are validator unit coverage, not fabricated renderer evidence.
In particular, a supported float path cannot use this diagnostic to excuse a
refusal, and a forced Canvas path still needs an explicit refusal/no-output test
bound to its actual capability contract. Non-GPU effect fallbacks remain open.

The existing workflow already executes `hdr-source.browser.mjs`. No tests,
browser, runtime, preparation, generation, build or index refresh ran locally.
Hosted exact-candidate execution and raw evidence remain pending. The fixture
uses production renderers, composition stores, masks, video decoding and output
conversion; no renderer mock or observed output baseline supplies the goldens.

## Remaining acceptance matrix

| Graph path | Existing coverage | Remaining qualification |
| --- | --- | --- |
| Effects / curves / LUTs | Existing 54-node effects matrix and declared HDR semantics; eight authored independent brightness/contrast/exposure/levels numerical cases, bound by hosted per-file hashes ([source contract](photometric-source-contract.md)) | Hosted execution of 1024 mandatory numerical channels; other 50 nodes, curves/LUT domains, collapsed/reversed levels (epsilon shader vs hard-threshold ledger wording), parameter interactions and animation goldens |
| Blends | Blend matrix, signed soft-light transport; authored nested alpha-coverage ramp | Hosted ramp execution; additional blend modes and supported hardware |
| Transitions / nested Compose | Float/transition matrices; nested float; authored decoded nested mask/SDR golden | Hosted execution; simultaneous nested PQ+HLG and all fallback paths |
| Masks | Allocation sites declared; authored functional alpha-mask inclusion/exclusion golden | Hosted execution; luma/inverted/combined/feathered mask goldens; HDR preserves/refuses every Canvas2D fallback |
| Non-GPU effects | Legacy fallback sites declared | Real HDR source keeps float or refuses each Canvas2D effect path |
| Text | Deliberate SDR graphic input | Numerical HDR reference-white and alpha-edge goldens |
| Lottie | Deliberate SDR graphic input | Real Lottie HDR reference-white golden with admitted resources |
| Mixed SDR/PQ/HLG | Authored simultaneous PQ+HLG+SDR and nested HDR/SDR packets | Hosted execution; simultaneous nested PQ+HLG, overlapping sources and complete delivery goldens |
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
