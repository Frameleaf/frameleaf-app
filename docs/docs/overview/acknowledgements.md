---
sidebar_position: 7
---

# Acknowledgements

Frameleaf is built on the work of other open-source projects. The full licence texts ship with
the application (Support and feedback → Third-party notices) and in the repository.

## Immich

Frameleaf is built on [Immich](https://github.com/immich-app/immich), the open-source,
self-hosted photo and video backup solution, and is distributed under its AGPL-3.0 licence.

## Freecut

Studio's video editor is [Freecut](https://github.com/walterlow/freecut), © its authors, used
under the MIT licence. Frameleaf builds it from the revision pinned in
`studio/freecut-provenance.json` (`4d62e8082c5eb387a96275bcbd323d28f6e41a62`) and verifies every
source file before building. The licence text and the notices of the components Freecut
bundles are in `studio/notices/` (see `studio/notices/NOTICE.md`).

## Media and runtime components

The server uses Node.js, libvips, ImageMagick, FFmpeg and ExifTool. Their versions and licences
are listed under Support and feedback → Third-party notices in the application.
