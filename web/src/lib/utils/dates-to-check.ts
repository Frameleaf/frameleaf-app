import { getTimeBucket, getTimelineDatesToCheck, TimelineDatesToCheck } from '@frameleaf/sdk';

type DatesToCheckQuery = Omit<Parameters<typeof getTimelineDatesToCheck>[0], 'pageSize'>;

const ATTEMPTS = 2;

/**
 * FL-1452: the ids of every photo whose date cannot be right, for these filters, read a page at a time
 * (`datesToCheck=only`). For "Fix dates" where no "Dates to check" group is drawn: a mixed album, or a
 * timeline in another order than the capture date. Each page is read with its bounds, so a page that
 * changed since the summary answers 409 and the whole read starts again from a fresh summary.
 */
export const readDatesToCheckIds = async (query: DatesToCheckQuery): Promise<string[]> => {
  for (let attempt = 1; ; attempt++) {
    try {
      const { pages = [] } = await getTimelineDatesToCheck({ ...query, pageSize: 500 });
      const ids: string[] = [];
      // One page at a time: a large import has many pages, and only their ids are wanted.
      for (const page of pages) {
        const bucket = await getTimeBucket({
          ...query,
          timeBucket: page.timeBucket,
          datesToCheck: TimelineDatesToCheck.Only,
          take: page.count,
          after: page.after ?? undefined,
          firstAssetId: page.firstAssetId,
          lastAssetId: page.lastAssetId,
        });
        ids.push(...bucket.id);
      }
      return ids;
    } catch (error) {
      if (attempt >= ATTEMPTS || (error as { status?: number } | null)?.status !== 409) {
        throw error;
      }
    }
  }
};
