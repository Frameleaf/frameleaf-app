import type { QueueItem } from './platform';

const uuid =
  /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;

/**
 * Where a saved item's "Open" goes on the user's server, or null while there is nothing to open.
 * A picture opens in the Boards viewer; a link opens in Boards' Links view with its inspector open.
 * The collection it was saved into does not change where the item itself opens.
 */
export function receiptLink(
  origin: string,
  item: Pick<QueueItem, 'state' | 'itemId' | 'itemKind'>,
): string | null {
  if (!origin || !item.itemId || !uuid.test(item.itemId)) return null;
  if (item.state !== 'saved' && item.state !== 'duplicate') return null;
  const id = encodeURIComponent(item.itemId);
  if (item.itemKind === 'asset') return `${origin}/pro/photos/${id}`;
  if (item.itemKind === 'bookmark')
    return `${origin}/pro?kinds=bookmark&bookmark=${id}`;
  return null;
}
