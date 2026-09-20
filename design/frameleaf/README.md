# Frameleaf design template

This is the reusable design handoff for implementation agents: the selected three-pane interface, the refined clickable prototype, design tokens, supplied SVG artwork and representative reference screens. Start here when implementing a Frameleaf screen.

| Reference | Use |
| --- | --- |
| [Interaction requirements](INTERACTION-REQUIREMENTS.md) | Durable user decisions, including later corrections to the original studies |
| [Runnable template](template/README.md) | Library, timeline, people, search/filtering, viewer, quick editor, Studio layout and settings command center |
| [Theme tokens](tokens.json) | Neutral surfaces, green selection, typography, modest radii and native touch targets |
| [Original SVG kit](brand-kit/manifest.json) | Authoritative source artwork with file hashes and intended uses |
| [Reference gallery](references/README.md) | Approved visual studies and selected historical implementation captures |
| [Source manifest](source-manifest.json) | Original paths, captured source hashes, packaged hashes and portability changes |

## Use the template

Read the interaction requirements and relevant reference screen, then inspect the matching component and styles in `template/src`. Preserve the complete source feature behavior when adapting the layout to production Svelte or native Flutter. Keep real permissions, owner scoping, API validation, persistence and recovery in their existing service boundaries.

Run the template independently using the instructions in [template/README.md](template/README.md). It includes local copies of its four source dependencies, so it does not need the uncommitted application changes, the main workspace's installed packages, Sites credentials or a running Frameleaf server. Serve it on a separate port from another active prototype to avoid replacing the user's preview.

The original source was an uncommitted working-tree design, captured on September 20, 2026. The manifest records each file's bytes and hash; the source checkout HEAD alone does not identify that design. The approved direction is preserved, while imports and build configuration were adapted for portability. Treat this committed copy as the agent handoff, and record intentional follow-up revisions rather than silently resnapshotting unrelated work.

## What is authoritative

Use the supplied `brand-kit/` SVGs for production branding. The generated `mark.png` and template `public/media/brand.png` remain historical visual assets used by the existing prototype, not replacements for the supplied vectors. The kit has no dark-ink wordmark for a white surface: use the gradient symbol, a deliberate dark brand surface, or an explicitly reviewed derivative. Retain original paths, gradients and notices. The brand styleboard is not an application background.

The design is dark-first with charcoal surfaces, fine separators, compact typography, limited radii and photography as its dominant content. Light mode receives equal care. Green, teal and blue convey identity, selection, focus or status. Preserve viewport fill, responsive panes, focus visibility and keyboard/touch alternatives.

Sample media, names, quantities, hardware and job states are fictional. Search resolves curated sample data; the Studio/restoration preview does not render edited outputs or run AI. Account/PIN/sharing controls do not provide production authorization. A responsive tablet web page is not native Flutter Studio. The template is not complete feature parity, a migration baseline for the rest of the application, or release qualification.

## Production handoff

Read the [implementation plan](https://heroit.atlassian.net/wiki/spaces/FR/pages/61538319), [agent execution guide](https://heroit.atlassian.net/wiki/spaces/FR/pages/61407516), and [development/delivery guide](https://heroit.atlassian.net/wiki/spaces/FR/pages/61407844), plus the assigned issue's action-level acceptance. Existing screen/settings/native/Freecut inventories remain the preservation contract. Missing prototype workflows must be implemented rather than removed from scope.

This package is the design-only baseline slice of [FL-25](https://heroit.atlassian.net/browse/FL-25), delivered through [PR #112](https://github.com/Frameleaf/frameleaf-app/pull/112). The other uncommitted application changes are not included or declared complete.
