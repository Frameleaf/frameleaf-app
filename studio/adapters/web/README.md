# Frameleaf web adapter for the Freecut engine

Studio's video editor is [Freecut](https://github.com/walterlow/freecut), © its authors, used under the MIT licence
(`studio/notices/freecut.txt`; all credits in `licenses/acknowledgements.json`). This package is Frameleaf's code around it.

## Web integration (FL-88)

The owner unparked the engine on 2026-09-25, and the web application now mounts it:

- This folder is the Frameleaf adapter. Built against the prepared `engine/` workspace and its
  lockfile (`node studio/tools/adapter.mjs build`, tests with `node studio/tools/adapter.mjs test`), it writes
  `web/static/studio-engine/` (gitignored): the editor document, a separate command runtime, a
  `manifest.json` naming the pinned revision, and the `notices/` and `attribution/` licence files.
  It replaces Freecut's File System Access workspace with a host-backed one, offers library media by
  asset id, forwards the editor's saves to the host as drafts, and routes Export, the exports list
  and the project bundle to Frameleaf's export dialog, Activity and portable bundles. Nothing in
  `studio/vendor/freecut` is edited; three editor modules are substituted by alias in the adapter build.
- `web/src/lib/frameleaf/studio/host-contract.ts` is the typed `mount` / `update` / `dispose`
  contract; `frame-protocol.ts` is the message protocol over one `MessageChannel` per mount;
  `frame-engine.ts` registers the built editor with `engine-loader.ts`, which refuses any engine
  whose revision is not the pinned commit and reports `not-built` when the build is absent.
- `engine-commands.ts` gives canonical commands (FL-92) their meaning through the command runtime;
  `bridge.ts` still decides shape, access, connectivity, lease, revision and capability first.
- Canonical `clip.split` validates every requested clip and splits each selected linked group once
  (FL-94), including requests containing both video and audio or repeated IDs. When linked selection
  is disabled, each selected clip is split independently. The adapter regression checks source ranges
  and resulting audio/video pairs. Hosted Actions runs it; full timeline conformance remains unqualified.
- Canonical trim commands reject partially clamped ranges after converting rational times to frames;
  a rejected command never stages a new graph. Freecut's interactive trim clamping is unchanged.
- Canonical moves preserve linked offsets and attached captions, respecting linked selection and
  track locks. A move that would place a member before frame zero rejects the entire batch.
- The FL-94 timeline tools are canonical engine commands too, each driven through Freecut's own
  action and refused (never clamped) when Freecut would shorten the request: `clip.roll`,
  `clip.slip` (a signed source-time delta), `clip.slide` (split chains keep source continuity),
  `clip.setSpeed` (an exact rational rate; the timeline length is computed exactly and later clips
  ripple), `clip.setLink`, `clip.reorder` (the track re-flows contiguously, linked sound follows),
  `clip.insert` and `clip.overwrite` (a marked source range at an exact source cadence; a VFR or
  unreadable cadence is refused), `track.set` (name, mute, lock, solo, visibility, sync lock and
  gain in dB), `track.remove`, `track.reorder` (among siblings) and `marker.add/update/remove`.
  `clip.join` (contiguous parts of one source, with their linked parts), `clip.push` (push or pull
  everything from a clip onward on every track) and `track.closeGap` (one gap or all) were added to
  the catalogue for the same rows.
  Insert opens the gap on its destination tracks and on sync-locked tracks, as Freecut's ripple
  does, and linked companions on tracks without sync lock follow so linked media stays in sync.
  Edits that would change a clip on a locked track are refused. `test/timeline-tools.test.ts`
  holds the golden graphs and the undo/redo round trip for every tool.
- `server/Dockerfile` builds the adapter in its `studio-engine` stage, which recovers the archive and
  fails if its SHA-256 or any of the 2,646 file hashes differ from `studio/freecut-provenance.json`.
