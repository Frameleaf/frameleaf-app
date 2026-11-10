import { AssetVisibility } from '@frameleaf/sdk';

/**
 * FL-795: what a person page's timeline asks for. Naming no visibility shows the timeline and the
 * archive, for a viewer who includes archived photos in People (Your preferences › Tools & sidebar ›
 * People options); otherwise the page shows timeline photos only, as it did before the option.
 */
export const personTimelineOptions = (personId: string, includeArchived: boolean) =>
  includeArchived ? { personId } : { visibility: AssetVisibility.Timeline, personId };
