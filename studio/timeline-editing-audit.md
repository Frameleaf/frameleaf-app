# FL-94 source audit

Audited integration base: `d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9` on
`master/frameleaf-implementation`, PR #140. The engine is Freecut
`4d62e8082c5eb387a96275bcbd323d28f6e41a62` with patches 0001–0055 and adapted
source SHA-256 `aaf508828b8881a3314e5b364da5326c6706dffe191fa6a63abe2dff67e4468c`.
Generated engine/vendor directories are immutable recovery inputs, not committed
application sources. `adapters/web/src/editor-frame.tsx` mounts the editor router,
authorized media, workspace and revision-gated draft persistence.

| Manifest row | Committed behavior and recovered engine anchors | Focused source checks |
| --- | --- | --- |
| `readme.timeline-editing.1` | Multitrack item rendering in `features/timeline/components/timeline-item/clip-content.tsx`; media, text, generated visual and compound item actions. The adapter retains the complete editor and persists its graph. Resource admission still governs external Lottie/font/model bytes. | Adapter `canonical-commands.test.ts`, `timeline-reload.test.ts`; upstream item actions and clip-content tests. |
| `readme.timeline-editing.2` | `components/sequence-tabs.tsx`, composition navigation and the sequences store; compound items open as sequences. Adapter graph load/save retains top-level sequence membership and nested track controls. | Adapter `timeline-reload.test.ts`; upstream sequence/composition navigation suites. |
| `readme.timeline-editing.3` | Canonical split/join, trim/ripple, roll, slip, slide, link and speed commands call the engine's existing timeline actions, preserving linked ranges and refusing invalid/locked edits. | Adapter `timeline-tools.test.ts`, graph conformance replay and host history assertions. |
| `readme.timeline-editing.4` | Transition items, trim handles and transition actions provide cut-centered alignment/resize and source-anchored previews; canonical transition commands persist the same graph. | Adapter canonical/graph-parameter tests; upstream linked transition actions and preview geometry tests. |
| `readme.timeline-editing.5` | Track flags and linked sync badges in the editor; canonical track set/remove/reorder, clip push and close-gap commands. Linked captions/audio and sync-locked companions are covered by the existing atomic gap guards. | Adapter `timeline-tools.test.ts`, `timeline-reload.test.ts`. |
| `readme.timeline-editing.6` | `clip-content.tsx` loads filmstrip/stereo waveform components; `use-filmstrip.ts` and `use-waveform-prefetch.ts` use the media caches. Snap calculation, markers, timecode and history are engine controls. Decode-derived thumbnails/waveforms are rebuilt from media rather than saved as graph data. | Existing upstream cache/render-window suites and adapter marker/history tests. Real-media browser regeneration after reload remains a separate qualification gate. |
| `readme.timeline-editing.7` | `features/editor/components/preview-area.tsx` mounts `features/preview/components/source-monitor.tsx`: source I/O, destination pickers, insert/overwrite and source shortcuts route through `source-edit-actions.ts`. Canonical marked source edits retain exact timing and reject inexact source cadences. | Adapter source-edit cases in `timeline-tools.test.ts`; upstream source-monitor, targeting, source-edit-actions and source-I/O suites. |
| `readme.timeline-editing.8` | Patch 0035 and `project-retime` enforce an explicit keep-time/keep-frames choice for rate changes on existing content, including templates and first-media match; metadata and converted timeline save atomically. The editor mounts configurable shortcut handlers. Patch 0033 derives HDR working range from placed media under the recorded owner color policy. | Adapter retime/reload cases; upstream project-retime, media-match dialog and shortcut suites. |

The missing non-mobile behavior found in this audit was touch access to the
mouse-based clip gesture tools. The adapter's `timeline-touch.ts` routes a single
primary touch on a timeline clip through those same handlers; the production CSS
keeps the gesture on the clip while other page areas retain native scrolling.
Existing hover logic chooses edge trim handles, and existing tools own linked
edits and history. The press waits one animation frame for hover layout, retaining
any early movement. Cancellation or loss of window focus undoes only the gesture's
new history entries and restores the earlier undo/redo stacks. Mouse, source I/O
pointer controls and editable inputs retain their existing event paths.
The bridge follows the editor component's lifetime: a project/graph remount
retires its listeners and pending gesture without synthesizing a commit. A
changed project or sequence cannot receive the prior context's movement or release. Commands
made independently during a touch remain in history after cancellation.

Run the focused adapter packet after preparing the engine and installing its
lockfile:

```sh
cd studio/engine
NODE_OPTIONS=--no-experimental-webstorage node node_modules/vitest/vitest.mjs run \
  --config ../adapters/web/vite.config.mjs --maxWorkers 1 --testTimeout 120000 \
  timeline-touch.test.ts timeline-tools.test.ts timeline-reload.test.ts virtual-workspace.test.ts
```

Validation: 51 focused checks passed (44 tool/reload, six virtual-workspace, one
touch regression). The manifest verifier confirmed all 2,646 immutable source
hashes; command validation confirmed 93 commands and 182 mapped feature rows.
The local run used bundled Node 24.19.0 and a generated web TypeScript config;
it is not a pinned-toolchain build attestation. The longer test deadline permits
the existing reload test to complete on this busy host without changing its
assertions. GitNexus's staged review maps the five intended files and reports LOW
risk; manual callers confirm the listener is installed only by `EditorApp`.
Chrome 154 native touch emulation against the mounted production Timeline also
passed linked video/audio movement, keyboard undo, cancelled drag with prior redo,
and linked edge trim. The same input without the bridge left the clips unchanged.
This used logical media records and the existing editor-controls browser fixture,
with hot reload disabled; it does not verify media decoding or physical hardware.

This source audit does not qualify long timelines on desktop/tablet, physical
tablet touch behavior, every browser, real-media cache regeneration, renderer
rights or deployment. Keep those claims separate from the user's feature-in-PR
tracking criterion. FL-94's implementation transition requires integration of
the touch packet into PR #140 first.
