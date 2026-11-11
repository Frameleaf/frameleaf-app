import {
  getMediaImport,
  MediaImportState,
  type AlbumResponseDto,
  type MediaImportResponseDto,
  type MediaSubscriptionCreateDto,
} from '@frameleaf/sdk';
import { newRequestKey } from '$lib/frameleaf/enrichment';

export type MediaInterval = NonNullable<MediaSubscriptionCreateDto['intervalMinutes']>;
export const MEDIA_INTERVALS = [15, 60, 360, 1440] as const;

export const mediaImportActive = (state: MediaImportState) =>
  [
    MediaImportState.Inspecting,
    MediaImportState.Queued,
    MediaImportState.Downloading,
    MediaImportState.Assembling,
    MediaImportState.Importing,
  ].includes(state);

export const mediaImportRetryable = (state: MediaImportState) =>
  [MediaImportState.Partial, MediaImportState.Failed, MediaImportState.Paused, MediaImportState.Cancelled].includes(
    state,
  );

export const pollMediaImport = (id: string, onUpdate: (value: MediaImportResponseDto) => void, onError: () => void) => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const refresh = async () => {
    try {
      const value = await getMediaImport({ id }, { signal: controller.signal });
      if (!controller.signal.aborted) {
        onUpdate(value);
        if (mediaImportActive(value.state)) {
          timer = setTimeout(() => void refresh(), 1500);
        }
      }
    } catch {
      if (!controller.signal.aborted) {
        onError();
        // The caller may stop the poll from `onError`.
        if (!controller.signal.aborted) {
          timer = setTimeout(() => void refresh(), 3000);
        }
      }
    }
  };
  timer = setTimeout(() => void refresh(), 500);
  return () => {
    clearTimeout(timer);
    controller.abort();
  };
};

/** Reuse the receipt key for the same request after an ambiguous network failure. */
export const mediaReceiptKey = (keys: Map<string, string>, payload: object) => {
  const signature = JSON.stringify(payload);
  const existing = keys.get(signature);
  if (existing) {
    return existing;
  }
  const key = newRequestKey();
  keys.set(signature, key);
  return key;
};

export const privateMediaParents = (albums: AlbumResponseDto[], ownerId: string) => {
  const byId = new Map(albums.map((album) => [album.id, album]));
  return albums.filter((album) => {
    const seen = new Set<string>();
    let current: AlbumResponseDto | undefined = album;
    while (current) {
      if (
        seen.has(current.id) ||
        current.shared ||
        current.hasSharedLink ||
        current.albumUsers[0]?.user.id !== ownerId
      ) {
        return false;
      }
      if (!current.parentId) {
        return true;
      }
      seen.add(current.id);
      current = byId.get(current.parentId);
    }
    return false;
  });
};

export const mediaDate = (value: string, locale?: string | null) =>
  new Date(value).toLocaleString(locale ?? undefined, { dateStyle: 'medium', timeStyle: 'short' });
