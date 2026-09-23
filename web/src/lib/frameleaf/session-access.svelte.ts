import { AssetVisibility } from '@immich/sdk';

/**
 * Whether this browser session is unlocked with the PIN (FL-34), for code outside the top bar that
 * needs to know: an unlocked session's timeline reveals the owner's own sensitive marks and
 * detections, so marking something there keeps it in view instead of removing it. The top bar,
 * which asks the server and hears every lock and unlock, keeps it current.
 */
export const sessionAccess = $state({ isElevated: false });

/**
 * True when a view with these options reveals the owner's marked and detected items to an unlocked
 * session: the main timeline, as the server decides it (`TimelineService.getRevealOptions`).
 */
export const revealsLocks = (
  options: { visibility?: AssetVisibility; albumId?: string },
  isElevated = sessionAccess.isElevated,
): boolean => isElevated && options.visibility === AssetVisibility.Timeline && !options.albumId;
