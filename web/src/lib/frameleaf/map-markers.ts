import { AssetTypeEnum, type MapMarkerResponseDto } from '@immich/sdk';
import { captureDay } from '$lib/frameleaf/explore';

/**
 * What the Map screen says about one located item (FL-51, prototype `MapView.jsx` hover card and
 * "In view" rows): its file name, the recorded capture day, its place and whether it is a video.
 * Markers only carry the name, day and type where the viewer may see the item's details; without
 * them the place (or nothing) stands in, never a guess.
 */
export type MarkerDetail = {
  /** the file name, or null when the marker does not carry one */
  name: string | null;
  /** `yyyy-MM-dd` of the recorded local capture day, or null */
  day: string | null;
  /** "City, Country" (or "State, Country"), or '' when unknown */
  place: string;
  /** the city alone, for the list rows */
  city: string | null;
  video: boolean;
};

export const markerPlace = (marker: Pick<MapMarkerResponseDto, 'city' | 'state' | 'country'>) =>
  [marker.city ?? marker.state, marker.country].filter(Boolean).join(', ');

export const markerDetail = (marker: MapMarkerResponseDto): MarkerDetail => ({
  name: marker.originalFileName?.trim() || null,
  day: marker.localDateTime ? captureDay({ localDateTime: marker.localDateTime }) : null,
  place: markerPlace(marker),
  city: marker.city ?? null,
  video: marker.type === AssetTypeEnum.Video,
});

/**
 * The hover card's second line (`MapView.jsx:654-656`): for one item its day and place, for a
 * bubble its place or, without one, its coordinates.
 */
export const markerCardLine = (detail: MarkerDetail) => [detail.day, detail.place].filter(Boolean).join(' · ');

/** An "In view" row's second line (`MapView.jsx:814-817`): day · city, and "Video" for a video. */
export const markerRowLine = (detail: MarkerDetail, videoLabel: string) =>
  [detail.day, detail.city, detail.video ? videoLabel : null].filter(Boolean).join(' · ');

/** The legend's photo and video counts for what is in view (`MapView.jsx:363-367`). */
export const markerTypeCounts = (markers: Pick<MapMarkerResponseDto, 'type'>[]) => {
  let videos = 0;
  for (const marker of markers) {
    if (marker.type === AssetTypeEnum.Video) {
      videos++;
    }
  }
  return { photos: markers.length - videos, videos };
};
