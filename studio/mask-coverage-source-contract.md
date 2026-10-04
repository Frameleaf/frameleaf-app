# Supported GPU mask golden contract (FL-97 / FL-99)

This is a static source binding for authored regression oracles, not a runtime
qualification report. No local source preparation, patch application, indexing,
build, browser or test execution produced this contract.

## Immutable source and hosted inventory

The upstream archive is Freecut commit
`4d62e8082c5eb387a96275bcbd323d28f6e41a62`, SHA256
`b4224e5c219a6302586cbe2242e9e6d299dfd1878f1fcd0f2d77ea3db12a5d32`.
Selected original files were streamed read-only from that archive.

The genuine hosted inventory for app head
`1b8a544824d533f3a5eef5105c1f1c21bf194114` has SHA256
`eb7fe48e7bd7e45704be3b6486b8332e95721c2d6eabbb816dd9b88ee209344a`.
It records run `37164769288`, engine job `111325645991`, artifact `11288737688`,
`digestMatched: true`, source digest
`7f8e1fee3117125038cbcd32a459d4ece5d930d5e281babf36a269bd7156ca22`,
and `runtimeQualified: false`. The engine configuration and patches have no
Git diff between that head and this packet's base
`b937340639e950f3d2c7811ae1832d52a1a0c7b4`.

| Source path | SHA256 and binding |
| --- | --- |
| `src/infrastructure/gpu-shapes/shape-render-pipeline.ts` | Original `1d945581c0340c34ce47d2fb221744475ac88dba568e2b74320b6e6474b4c2d2`; prepared inventory `09212533d73bef1a047d8e2b5c8ba8529e355e252f712bed51838e47c4caf712` |
| `src/infrastructure/gpu-masks/mask-combine-pipeline.ts` | Original matches prepared inventory `73127b257fc6f527be5979c5775688a62bcc74eadd058fd2ac1213d039f49f91` |
| `src/features/export/utils/canvas-masks.ts` | Original matches prepared inventory `ad0416c3d333ee939ec37eaa4e58210bdd5680f923b2089228baf60ca519ada9` |
| `src/types/timeline.ts` | Original matches prepared inventory `673ba1c184800f7477fe6a23ff3686596abfd2c28f41c4499bd698d4a42cc448` |
| `src/features/export/utils/canvas-item-renderer/gpu.ts` | Prepared inventory `71d5f7e9a493f957efaba30e5b9a86c29eaa4bf2c23f9c475012b68f76d4a34d`; adapted file differs from original |
| `src/features/export/utils/canvas-item-renderer/composition.ts` | Prepared inventory `badf84caf56b2496d2e103b799941cfa6adced9ef1dc4d5ab97da12dae090662` |

Only patch `0016-nested-float-transport.patch` modifies the shape-render file in
the configured series. Its SHA256 is
`39fd2b12f6971cebb4e020f23888d399eb36c89eb110a03ccebc1630e5de3e43`.
The inspected delta changes attachment formats, float pipeline selection and
parentheses around trim predicates. It leaves rectangle distance, feather
smoothstep, matte opacity and the relevant uniform value unchanged. The original
and prepared shape hashes are intentionally different; no reconstructed full
prepared-file hash is claimed here.

## Independent numerical oracles

The regression places masks inside a real nested composition, invoking the GPU
shape-mask route. `getActiveSubCompMasks` carries the prepared opacity, inversion
and feather into `renderGpuSubCompMaskToTexture`. It draws a white rectangle with
the mask's opacity and `maskFeatherPixels`. The original shape shader defines:

- rectangle signed distance `d`, negative inside;
- edge width `w = max(maskFeatherPixels, 0.75)`;
- coverage `1 - smoothstep(-w, w, d)`;
- matte alpha = coverage times prepared opacity.

The CPU oracle evaluates the cubic `1 - t²(3 - 2t)` with
`t = clamp((d + w) / (2w), 0, 1)`. Prepared opacity is
`maskOpacity / 100` times transform opacity. Each mask attachment is bounded
`rgba8unorm`, so its alpha is quantized to the nearest 1/255 before inversion.
The combine shader applies each requested inversion and multiplies the mattes;
the combined attachment is quantized again. The oracle includes those stages.
This bounded matte representation never permits quantizing or clipping HDR RGB.

The feathered rectangle's left edge is at x=32.5. Texel-center samples at x=32
have distance zero; x=30 and x=34 have distances +2 and -2. With feather 4 their
unquantized coverages are 0.5, 0.15625 and 0.84375. Samples at x=28 and x=36 reach
the exact zero/one plateaus, and x=16/48 are farther plateau witnesses. Inversion
uses one minus the quantized matte. Off-center goldens must distinguish this
profile from the width-0.75 hard-edge counterfactual. No measured mask output
supplies an expected answer.

Each decoded source independently supplies its CPU working RGB from its actual
Y'CbCr planes. Exposure doubles that RGB; matte alpha and root opacity 0.75
compose it over SDR background 0.2. Both explicit PQ/HLG outputs must equal the
CPU conversion. Existing picture tolerance 0.004 and alpha tolerance 1e-6 remain.

Only `clip` and `alpha` are supported mask types. Luma is a missing production
feature; an unknown mask type cannot serve as luma evidence. Canvas bitmap masks,
corner pinning, rotated/path masks, all fallback paths, and hardware/display
qualification remain outside this bounded packet.
