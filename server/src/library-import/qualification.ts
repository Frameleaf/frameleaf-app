import { type SourceKind } from 'src/library-import/manifest.js';

/** Research targets are not source compatibility claims. Promotion requires hosted and DSM qualification. */
export const qualificationTargets: Readonly<Record<SourceKind, string | null>> = Object.freeze({
  immich: 'existing-importer',
  photoprism: '261029-963b58c50',
  librephotos: '1.5.1',
  photoview: 'v2.4.0',
  piwigo: '16.4.0',
  lychee: 'v7.12.0',
  pigallery2: '3.5.2',
  ente: null,
  nextcloud: '35/photos-8/memories-10.2',
  synology: null,
});
