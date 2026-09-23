import { Kysely, sql } from 'kysely';

/**
 * FL-102 (VID-104): channel-aware audio.
 *
 * An audio track's channel count, channel layout and sample rate are facts about the source
 * that a render has to know in order to preserve them. Without them the only safe thing a
 * transcode can do is fold to stereo, which is acceptable for a playback proxy and never for
 * a master.
 *
 * Additive and nullable: existing rows keep whatever they have, and null means "not probed",
 * never "stereo". A render that finds null emits no channel argument at all rather than
 * guessing, so an unmigrated row cannot turn into a silent downmix. Extraction refills the
 * columns on the next metadata pass, so no backfill is required.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_audio" ADD COLUMN "channels" smallint`.execute(db);
  await sql`ALTER TABLE "asset_audio" ADD COLUMN "channelLayout" text`.execute(db);
  await sql`ALTER TABLE "asset_audio" ADD COLUMN "sampleRate" integer`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_audio" DROP COLUMN "sampleRate"`.execute(db);
  await sql`ALTER TABLE "asset_audio" DROP COLUMN "channelLayout"`.execute(db);
  await sql`ALTER TABLE "asset_audio" DROP COLUMN "channels"`.execute(db);
}
