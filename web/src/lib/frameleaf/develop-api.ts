/**
 * Client access to the still-image develop pipeline (FL-113).
 *
 * Thin wrappers over the generated SDK plus the two things the editor needs beyond it: a
 * debounced, cancellable preview request that yields an object URL, and a poll that follows a
 * render to completion. Progress is polled rather than pushed; the revision row is the durable
 * source of truth for the job, so a reload lands on the same state.
 */
import {
  AssetDevelopFileKind,
  getAssetDevelop,
  getBaseUrl,
  previewAssetDevelop,
  type AssetDevelopRecipeDto,
  type AssetDevelopResponseDto,
} from '@immich/sdk';
import { anyRevisionBusy } from '$lib/frameleaf/editor-draft';
import { authManager } from '$lib/managers/auth-manager.svelte';

export const PREVIEW_DEBOUNCE_MS = 350;
export const RENDER_POLL_MS = 1200;

/** Where the editor fetches a rendered version's preview or master from. */
export const developFileUrl = (
  assetId: string,
  revisionId: string,
  kind: AssetDevelopFileKind = AssetDevelopFileKind.Preview,
  cacheKey?: string | null,
) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...authManager.params, kind, c: cacheKey ?? undefined })) {
    if (value !== undefined && value !== null) {
      search.set(key, value);
    }
  }
  return `${getBaseUrl()}/assets/${encodeURIComponent(assetId)}/develop/revisions/${encodeURIComponent(revisionId)}/file?${search.toString()}`;
};

export type PreviewResult = { url: string; revoke: () => void };

/**
 * Renders the recipe on the server at preview size and returns an object URL. The caller owns
 * the URL and revokes it when a newer preview replaces it; an aborted request resolves to null.
 */
export async function requestDevelopPreview(
  assetId: string,
  recipe: AssetDevelopRecipeDto,
  size: number,
  signal?: AbortSignal,
): Promise<PreviewResult | null> {
  try {
    const blob = await previewAssetDevelop({ id: assetId, assetDevelopPreviewDto: { recipe, size } }, { signal });
    if (signal?.aborted) {
      return null;
    }
    const url = URL.createObjectURL(blob);
    return { url, revoke: () => URL.revokeObjectURL(url) };
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      return null;
    }
    throw error;
  }
}

/**
 * Follows the asset's revisions while any render is queued or running, calling `onUpdate`
 * with each fresh listing. Returns a stop function; stopping is idempotent.
 */
export function followDevelop(
  assetId: string,
  onUpdate: (develop: AssetDevelopResponseDto) => void,
  options: { intervalMs?: number; onError?: (error: unknown) => void } = {},
): () => void {
  const interval = options.intervalMs ?? RENDER_POLL_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (stopped) {
      return;
    }
    try {
      const develop = await getAssetDevelop({ id: assetId });
      if (stopped) {
        return;
      }
      onUpdate(develop);
      if (anyRevisionBusy(develop.revisions)) {
        timer = setTimeout(() => void tick(), interval);
      }
    } catch (error) {
      if (!stopped) {
        options.onError?.(error);
      }
    }
  };
  void tick();
  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
    }
  };
}
