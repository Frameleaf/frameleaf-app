import { sql } from 'kysely';

/** Canonical unaliased read row; waiting interest never proves an open reader or native writer stopped. */
export const sourceReadHasInterest = sql<boolean>`(
  NOT source_resource_read."consumerManaged" OR EXISTS (
    SELECT 1 FROM source_resource_read_consumer consumer
    WHERE consumer."readId"=source_resource_read.id
      AND (consumer."expiresAt" IS NULL OR consumer."expiresAt">clock_timestamp())
  )
)`;
