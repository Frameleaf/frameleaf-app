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
  DynamicRange2,
  getAssetDevelop,
  defaults,
  getBaseUrl,
  previewAssetDevelop,
  type AssetDevelopRecipeDto,
  type AssetDevelopResponseDto,
} from '@frameleaf/sdk';
import type { HistogramBins } from '$lib/frameleaf/develop';
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
  format?: 'sdr-jpeg' | 'hdr-jpeg' | 'hdr-heic',
) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...authManager.params, kind, format, c: cacheKey ?? undefined })) {
    if (value !== undefined && value !== null) {
      search.set(key, value);
    }
  }
  return `${getBaseUrl()}/assets/${encodeURIComponent(assetId)}/develop/revisions/${encodeURIComponent(revisionId)}/file?${search.toString()}`;
};

export type HdrHistogram = HistogramBins & {
  version: 1;
  minStops: number;
  maxStops: number;
  referenceWhite: number;
  peakStops: number;
};
export type PreviewResult = { url: string; revoke: () => void; histogram?: HdrHistogram };

/** Treat response metadata as untrusted; invalid evidence must never become an HDR histogram. */
export function parseHdrHistogram(header: string | null): HdrHistogram | undefined {
  if (!header || header.length > 8192) {
    return;
  }
  try {
    const value = JSON.parse(header) as HdrHistogram;
    if (
      value.version !== 1 ||
      value.bins !== 64 ||
      value.minStops !== -10 ||
      value.maxStops !== 6 ||
      value.referenceWhite !== 203
    ) {
      return;
    }
    const numbers = [value.max, value.samples, value.peakStops, value.clipped?.shadows, value.clipped?.highlights];
    if (
      numbers.some((number) => !Number.isFinite(number)) ||
      value.max < 1 ||
      value.samples < 0 ||
      value.peakStops < -10 ||
      value.peakStops > 6
    ) {
      return;
    }
    if ([value.clipped.shadows, value.clipped.highlights].some((number) => number < 0 || number > 1)) {
      return;
    }
    if (
      [value.red, value.green, value.blue, value.luma].some(
        (bins) =>
          !(
            Array.isArray(bins) &&
            bins.length === 64 &&
            bins.every((count) => Number.isSafeInteger(count) && count >= 0 && count <= value.samples)
          ),
      )
    ) {
      return;
    }
    return value;
  } catch {
    return;
  }
}

/**
 * Renders the recipe on the server at preview size and returns an object URL. The caller owns
 * the URL and revokes it when a newer preview replaces it; an aborted request resolves to null.
 */
export async function requestDevelopPreview(
  assetId: string,
  recipe: AssetDevelopRecipeDto,
  size: number,
  signal?: AbortSignal,
  dynamicRange?: 'auto' | 'sdr' | 'hdr',
): Promise<PreviewResult | null> {
  try {
    let histogram: HdrHistogram | undefined;
    const blob = await previewAssetDevelop(
      {
        id: assetId,
        assetDevelopPreviewDto: {
          recipe,
          size,
          ...(dynamicRange && {
            dynamicRange: DynamicRange2[dynamicRange === 'auto' ? 'Auto' : dynamicRange === 'sdr' ? 'Sdr' : 'Hdr'],
          }),
        },
      },
      {
        signal,
        ...([3, 4, 5, 6].includes(recipe.version) && {
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const response = await (defaults.fetch ?? fetch)(input, init);
            histogram = parseHdrHistogram(response.headers.get('X-Frameleaf-HDR-Histogram'));
            return response;
          },
        }),
      },
    );
    if (signal?.aborted) {
      return null;
    }
    const url = URL.createObjectURL(blob);
    return { url, revoke: () => URL.revokeObjectURL(url), ...(histogram && { histogram }) };
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
  options: {
    intervalMs?: number;
    onError?: (error: unknown) => void;
    continueWhile?: (develop: AssetDevelopResponseDto) => boolean;
  } = {},
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
      if (!stopped && (anyRevisionBusy(develop.revisions) || options.continueWhile?.(develop))) {
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
