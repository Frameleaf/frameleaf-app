import type { ColumnType } from 'kysely';

/** PostgreSQL bigint accepts decimal text on writes without a JavaScript number round trip. */
export type Int8Writable = ColumnType<number, number | string, number | string>;
