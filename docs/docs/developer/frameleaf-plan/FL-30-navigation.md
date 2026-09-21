# FL-30 production navigation rollout

This is a bounded web implementation of [FL-30](https://heroit.atlassian.net/browse/FL-30), based on accepted `fork/main` commit `fc9d12d38ab707dd368298df84af2848106529be`. The [implementation plan](https://heroit.atlassian.net/wiki/spaces/FR/pages/61538319) and action-preservation ledger remain authoritative. FL-30 stays In Progress; native applications are deferred.

## Implemented behavior

Enable **Frameleaf navigation** in User settings → App settings. This browser-local `frameleaf-shell` preference defaults to false. Disable it to restore the existing navigation immediately. The preference selects navigation markup and scoped appearance inside the existing Sidebar; it does not wrap/remount route content, clear drafts, navigate, change a server capability, or rewrite library data. Existing theme, `sidebar-collapsed`, sidebar width, album tree and recent-album preferences remain authoritative.

`web/src/lib/components/frameleaf/route-registry.json` supplies the real navigation entries consumed by `Navigation.svelte` through the existing `Route` helpers. Timeline comes first. Explore, Best Photos and Locked retain their established destinations. Album hierarchy/recent albums retain their existing components and data services. Recently added appears once and respects its visibility preference. Utilities and Trash sit in the Settings navigation group; there are no duplicate-review/large-file/Live Photo shortcuts in the Library group.

The production Sidebar retains responsive overlay behavior, focus trapping, Escape/outside dismissal and collapse control. Collapsed link text is visually hidden while remaining available to screen readers. Frameleaf tokens are scoped to the opt-in sidebar and use the existing theme manager. `Brand` uses the unchanged supplied `frameleaf-logo-white.svg` on its deliberate dark background; original artwork is unchanged. The existing navigation header, storage/status information and route content remain in place pending their replacement acceptance.

## Preservation and authority

The registry is presentation metadata, never an authorization decision. Search/Map/Trash still follow server capabilities. People, Memories, Shared links, Tags and Folders require their existing enabled and sidebar-visible preferences. Backend checks and route loaders remain unchanged, including PIN-sensitive Locked behavior, administrator authentication, public share key/password handling, maintenance authentication and login continuation. The accepted 70-route inventory remains the complete preservation catalog; this smaller navigation registry does not claim to replace it.

No production Studio, Activity, Browse/Work session or command-center route is fabricated from dirty-only evidence. Public/auth/error/admin shells keep their established loaders/layouts. The historical Confluence web-shell snapshot (page 61440119) describes unreviewed application work; its build-time flag and absent routes are not implementation evidence for this packet.

## Verification and remaining acceptance

Focused unit/component tests exercise real route resolution, capability and separate preference gating, unique destinations, deep-route active links, expanded/icon navigation, persisted collapse and in-place appearance rollback. The route-inventory tests retain all accepted families. These tests do not establish browser-back restoration, server authorization, actual screen-reader output, visual fidelity across viewports or draft recovery in an authenticated application.

Run from `web/` with the pinned Node 24 toolchain:

```sh
pnpm exec vitest run src/lib/components/frameleaf/navigation-registry.spec.ts src/lib/components/frameleaf/navigation-component.spec.ts src/lib/components/sidebar/Sidebar.spec.ts --maxWorkers=2
```

Run `node --test scripts/frameleaf-route-inventory.test.mjs` and `node scripts/frameleaf-documentation-coverage.mjs` from the committed candidate root. Independent permission/privacy review and hosted checks are separate delivery gates. Full Settings utilities/Trash workflow redesign, command-center system information, shared session/Browse/Work, Studio/Activity, collection slideshow qualification, auth/public/error branding, authenticated deep-link/back/draft checks and wider accessibility/visual acceptance remain open. No API, schema, migration, native or worker changes are included.
