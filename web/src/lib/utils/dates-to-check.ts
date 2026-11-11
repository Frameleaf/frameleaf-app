import { getTimeBucket, getTimelineDatesToCheck, TimelineDatesToCheck } from '@frameleaf/sdk';

type DatesToCheckQuery = Omit<Parameters<typeof getTimelineDatesToCheck>[0], 'pageSize'>;

/**
 * FL-1452: the ids of every photo whose date cannot be right, for these filters, read a page at a time
 * (`datesToCheck=only`). For "Fix dates" where no "Dates to check" group is drawn: a mixed album, or a
 * timeline in another order than the capture date.
 */
export const readDatesToCheckIds = async (query: DatesToCheckQuery): Promise<string[]> => {
  const { pages = [] } = await getTimelineDatesToCheck({ ...query, pageSize: 500 });
  const buckets = await Promise.all(
    pages.map((page) =>
      getTimeBucket({
        ...query,
        timeBucket: page.timeBucket,
        datesToCheck: TimelineDatesToCheck.Only,
        take: page.count,
        after: page.after ?? undefined,
      }),
    ),
  );
  return buckets.flatMap((bucket) => bucket.id);
};
