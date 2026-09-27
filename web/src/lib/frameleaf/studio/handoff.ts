/**
 * The "make a movie" handoff into Studio (FL-88).
 *
 * The prototype opens Studio from three places — the memory player's "Make a movie in
 * Studio", the viewer's "Open in Studio" and the command palette — and each of them carries
 * the current selection. In production those are route links, so the selection travels in
 * the URL: `/studio?assets=<id>,<id>` and optionally `?project=<id>`.
 *
 * Parsing is defensive because the query string is the least trustworthy input the route
 * has. It is also deliberately conservative: ids keep the caller's order (the selection
 * order becomes the first cut), duplicates collapse to the first occurrence, anything that
 * is not a plain identifier is dropped, and the list is capped so a pasted URL cannot make
 * the loader issue thousands of requests.
 */

/** Enough for a long memory or a large selection; beyond this the bin is the better path. */
export const maxStudioHandoffAssets = 200;

const identifier = /^[\w-]{1,64}$/;
/** An exact playhead in seconds, `num/den` (FL-93). */
const playheadPattern = /^\d{1,15}\/[1-9]\d{0,8}$/;

export interface StudioHandoff {
  /** The project to open, or null for a new draft. */
  projectId: string | null;
  /** Asset ids to start from, in the order the person selected them. */
  assetIds: string[];
  /**
   * Accepted restorations the person chose with Use in Studio (FL-115), `?restored=<id>,<id>`. Each
   * enters the bin as its own version beside, never instead of, its original.
   */
  restorationIds: string[];
  /**
   * The asset whose quick editor opened Studio (FL-113). Studio offers the way back to it, and the
   * draft the person left there is waiting for them.
   */
  returnTo: string | null;
  /** Where the quick editor's playhead was, as exact seconds (`num/den`), so Studio starts there. */
  at: { num: number; den: number } | null;
}

/** Plain identifiers from a comma list, in order, deduplicated and capped. */
const identifierList = (value: string | null): string[] => {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const raw of (value ?? '').split(',')) {
    const id = raw.trim();
    if (!identifier.test(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
    if (ids.length >= maxStudioHandoffAssets) {
      break;
    }
  }
  return ids;
};

export const parseStudioHandoff = (params: URLSearchParams): StudioHandoff => {
  const projectId = params.get('project');
  const assetIds = identifierList(params.get('assets'));
  const restorationIds = identifierList(params.get('restored'));

  const returnTo = params.get('from');
  const at = params.get('at');
  const [num, den] = at && playheadPattern.test(at) ? at.split('/').map(Number) : [];

  return {
    projectId: projectId && identifier.test(projectId) ? projectId : null,
    assetIds,
    restorationIds,
    returnTo: returnTo && identifier.test(returnTo) ? returnTo : null,
    at: num !== undefined && den !== undefined && Number.isSafeInteger(num) ? { num, den } : null,
  };
};

/** Build the link the library, the viewer and the memory player use to open Studio. */
export const studioHandoffQuery = ({
  projectId,
  assetIds = [],
  restorationIds = [],
  returnTo,
  at,
}: {
  projectId?: string | null;
  assetIds?: readonly string[];
  restorationIds?: readonly string[];
  returnTo?: string | null;
  at?: { num: number; den: number } | null;
}): string => {
  const params = new URLSearchParams();
  if (projectId) {
    params.set('project', projectId);
  }
  const ids = assetIds.filter((id) => identifier.test(id)).slice(0, maxStudioHandoffAssets);
  if (ids.length > 0) {
    params.set('assets', ids.join(','));
  }
  const restored = restorationIds.filter((id) => identifier.test(id)).slice(0, maxStudioHandoffAssets);
  if (restored.length > 0) {
    params.set('restored', restored.join(','));
  }
  if (returnTo && identifier.test(returnTo)) {
    params.set('from', returnTo);
  }
  if (at && playheadPattern.test(`${at.num}/${at.den}`)) {
    params.set('at', `${at.num}/${at.den}`);
  }
  const query = params.toString();
  return query ? `?${query}` : '';
};
