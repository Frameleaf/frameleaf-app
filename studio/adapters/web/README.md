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
- `server/Dockerfile` builds the adapter in its `studio-engine` stage, which recovers the archive and
  fails if its SHA-256 or any of the 2,646 file hashes differ from `studio/freecut-provenance.json`.
