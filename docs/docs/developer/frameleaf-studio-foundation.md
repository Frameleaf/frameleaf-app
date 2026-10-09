# Studio rights and distribution-gate foundation

Studio (the video editor, built on a pinned, adapted Freecut engine) ships fonts, voices, models,
bundled weights, runtime downloads and a handful of external tools. None of that can be
distributed, run locally, or offered on Frameleaf Cloud just because it is technically reachable.
This page is the map of the four files that decide and enforce that, and of the release-time gates
(FL-136 / REL-104) that sit on top of them for the web bundle, worker container and cloud
execution. Native/mobile app store distribution is out of scope everywhere on this page: native
apps ship from their own separate repos (owner decision, 2026-09-29).

## The four sources of truth

1. **`studio/dependency-attribution.json`** - the reviewed bill of materials. Every model, voice,
   font, bundled weight, runtime download, external asset and tool the pinned engine can reach has
   an `id` (`<kind>:<name>`) and three decisions (`redistribution`, `localRuntime`, `hostedUse`),
   each `allowed` or `blocked`, as the engine packager reviewed them (FL-84/FL-86). It also records
   `embeddedComponents`: third-party binaries embedded _inside_ the engine build (FFmpeg, LAME,
   TurboRes, the MOSS ONNX runtime and tokenizer) with a `rightsStatus` that stays `blocked` until
   their exact embedded-source mapping and LGPL/MPL corresponding-source obligations are qualified -
   a wrapper's own licence text is not enough. And `dolbyTools`: the Dolby Vision professional
   tools (CM Analyze, Metafier, Mezzinator, artistic trims) are `included: false` - administrator-
   installed only, never bundled or auto-installed.
2. **`studio/rights-approval.json`** - the owner's approval. It lists the exact rows the owner
   approved (FL-146, 2026-09-25: all 210 bundled resources), each bound to a digest of that row in
   `dependency-attribution.json`. If a row changes after approval, or a resource is new or unknown,
   it stays blocked. `excludedUses` records uses the owner withheld even on an approved row - for
   example MusicGen small stays off Frameleaf Cloud (CC-BY-NC-4.0), while local/server/LAN-worker
   use is approved.
3. **`server/src/utils/studio-rights.generated.ts`** (built by `scripts/frameleaf-studio-rights.mjs`
   from the two files above) - the engine-runtime admission mirror. This is the only place a Studio
   resource is actually admitted or refused while a project is open; it is owned by the Studio
   engine work and this page does not duplicate it.
4. **`licenses/acknowledgements.json`** (built into `licenses/THIRD-PARTY-NOTICES.md` and
   `docs/docs/overview/acknowledgements.md` by `scripts/frameleaf-acknowledgements.mjs`) - the
   public credit register: every Studio resource plus every photo-library machine learning model,
   with its licence, how it reaches people (bundled, downloaded, administrator-installed) and the
   licence text that ships with it.

## The release-time gate register

**`studio/distribution-gates.json`** (validated by `scripts/frameleaf-distribution-gates.mjs`) is
the fifth file, and the one FL-136 owns. It does not re-decide anything in the four files above -
it reads them. It exists for two things those files do not cover:

- **Linking every currently-blocked embedded/tool obligation to a named owner and an explicit
  release gate.** The validator cross-checks that every `embeddedComponents` row still marked
  `blocked` in `dependency-attribution.json`, and the Dolby tool gate, has a matching open entry
  here - so a blocked dependency cannot quietly stop being tracked.
- **Recording the distribution concerns that are not Studio resources at all**: Frameleaf Cloud's
  billing account and privacy disclosure, model-download consent, and (cross-referenced, not
  duplicated) the GHCR/cosign credentials already gated by FL-24's release workflow.

Each gate has a `status` of `cleared` (names the owner who cleared it) or `blocked-on-owner` (names
no owner - only the owner, not an agent, can clear it). Run `node
scripts/frameleaf-distribution-gates.mjs` to verify the register; it is part of the fork-integration
workflow's "Validate delivery workflow contracts" step.

## What still needs the owner

As of this page's last update, `studio/distribution-gates.json` records these as
`blocked-on-owner`, and no agent may clear them:

- **Dolby tool admission** - a qualified worker address, administrator-installed CM
  Analyze/Metafier/Mezzinator paths and verified candidate-chain versions (FL-109 / VID-204).
- **Embedded codec corresponding source** - legal/engineering review of the FFmpeg, LAME, TurboRes
  and MOSS ONNX runtime/tokenizer wrappers embedded in the engine build before they can ship.
- **Frameleaf Cloud billing account** - naming the account and payment processor of record.
- **Frameleaf Cloud privacy disclosure** - owner/legal sign-off on what is processed, where, and
  for how long.

Read the gate register itself for the exact reason and enforcement pointer for each.

## Scope capture revision ownership (FL-98)

The web adapter publishes an ephemeral scope owner only after the current editor mount finishes
loading its timeline. It invalidates that owner before remount loading or disposal, and replaces it
when the host confirms the same graph at a newer stored revision. This uses the existing editor
mount and revision authority; no persisted graph, server, or database contract changes.

A scoped capture binds its concrete rendered target frame, known color signal, loaded base revision,
and local edit inputs before asynchronous pixel production. Producer completion and GPU/CPU scope
presentation both reject superseded ownership, graph inputs, or seek epochs. The header identifies
the accepted sample's base revision and local edits; an unavailable owner refuses capture, and an
older displayed sample is marked stale. A base revision does not claim that unsaved or live preview
edits are stored in that revision. Still export, thumbnails, eyedroppers, and color wheels retain the
existing bare-pixel capture callbacks.

Local deferred tests cover capture ownership and presentation interleavings. They do not qualify
browser/GPU/media behavior or complete the FL-98 acceptance rows: gizmo reachability/hit geometry,
Clock playback, warming/adaptive preview isolation, 2/4-up edits, all scope measurements, separate
monitor/master audio, Color workspace, and Bento still require their full conformance evidence.
