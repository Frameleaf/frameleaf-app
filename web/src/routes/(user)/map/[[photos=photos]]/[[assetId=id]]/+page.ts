import { getAlbumInfo, getAlbumMapMarkers } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url);
  const $t = await getFormatter();

  // Opened from an album's Map action: the same screen, scoped to that album's located items.
  const albumId = url.searchParams.get('albumId');
  const [album, albumMarkers] = albumId
    ? await Promise.all([getAlbumInfo({ id: albumId }), getAlbumMapMarkers({ id: albumId })])
    : [undefined, undefined];

  return {
    album,
    albumMarkers,
    meta: {
      title: album ? `${album.albumName} · ${$t('map')}` : $t('map'),
    },
  };
}) satisfies PageLoad;
