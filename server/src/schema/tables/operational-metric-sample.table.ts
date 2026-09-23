import { Column, ForeignKeyColumn, Table, Unique } from '@immich/sql-tools';
import type { Generated, Int8, Timestamp } from '@immich/sql-tools';
import { PrimaryGeneratedUuidV7Column } from 'src/decorators.js';
import { AnalyticsSampleGrain, AnalyticsSeriesId } from 'src/enum.js';
import { LibraryTable } from 'src/schema/tables/library.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * One observation of one approved operational series (FL-79). Mirrors migration
 * 2100000000560-AddOperationalMetricSample.
 *
 * **Local only, counts and sizes only.** The nightly analytics collector writes these rows and the
 * analytics report reads them; nothing is ever sent anywhere. A row carries a series id from the
 * registry in `src/utils/analytics.ts`, a scope key made of ids alone (`host`, `account:<uuid>` or
 * `library:<uuid>`), a bucket and a number: never a name, a path, a prompt, a credential or a job
 * payload. `assertApprovedSample` refuses anything else before it is written.
 *
 * `grain` is `day` for recent history and `week` once a day row has been downsampled; see the
 * retention rules next to the registry. Account and library rows cascade with their account or
 * library, so removing either removes its history.
 */
@Unique({ columns: ['series', 'scopeKey', 'grain', 'bucketStart'] })
@Table({ name: 'operational_metric_sample' })
export class OperationalMetricSampleTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  /** `AnalyticsSeriesId`. */
  @Column()
  series!: AnalyticsSeriesId;

  /** `host`, `account:<uuid>` or `library:<uuid>`. */
  @Column()
  scopeKey!: string;

  /** The account an `account:` row is about. */
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: true })
  userId!: string | null;

  /** The library a `library:` row is about. */
  @ForeignKeyColumn(() => LibraryTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: true })
  libraryId!: string | null;

  /** `AnalyticsSampleGrain`. */
  @Column()
  grain!: AnalyticsSampleGrain;

  /** UTC midnight that starts the bucket: the day, or the Monday of the week. */
  @Column({ type: 'timestamp with time zone' })
  bucketStart!: Timestamp;

  @Column({ type: 'bigint' })
  value!: Int8;

  /** When the value was read. A week row keeps the time of the day row it came from. */
  @Column({ type: 'timestamp with time zone' })
  observedAt!: Timestamp;
}
