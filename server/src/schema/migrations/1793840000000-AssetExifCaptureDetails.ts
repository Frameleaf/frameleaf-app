import { Kysely, sql } from 'kysely';

/** FL-1196: more of what cameras record, for the library's own reports. Nullable, so existing rows stay as they are. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE public.asset_exif
    ADD COLUMN "altitude" double precision,
    ADD COLUMN "shutterCount" integer,
    ADD COLUMN "focalLengthIn35mm" double precision,
    ADD COLUMN "exposureCompensation" double precision,
    ADD COLUMN "exposureProgram" character varying,
    ADD COLUMN "meteringMode" character varying,
    ADD COLUMN "flash" character varying,
    ADD COLUMN "whiteBalance" character varying,
    ADD COLUMN "sceneCaptureType" character varying,
    ADD COLUMN "focusDistance" double precision,
    ADD COLUMN "lensMake" character varying,
    ADD COLUMN "lensSerialNumber" character varying,
    ADD COLUMN "serialNumber" character varying,
    ADD COLUMN "software" character varying,
    ADD COLUMN "artist" character varying,
    ADD COLUMN "copyright" character varying,
    ADD COLUMN "imageDirection" double precision,
    ADD COLUMN "gpsSpeed" double precision`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE public.asset_exif
    DROP COLUMN "altitude",
    DROP COLUMN "shutterCount",
    DROP COLUMN "focalLengthIn35mm",
    DROP COLUMN "exposureCompensation",
    DROP COLUMN "exposureProgram",
    DROP COLUMN "meteringMode",
    DROP COLUMN "flash",
    DROP COLUMN "whiteBalance",
    DROP COLUMN "sceneCaptureType",
    DROP COLUMN "focusDistance",
    DROP COLUMN "lensMake",
    DROP COLUMN "lensSerialNumber",
    DROP COLUMN "serialNumber",
    DROP COLUMN "software",
    DROP COLUMN "artist",
    DROP COLUMN "copyright",
    DROP COLUMN "imageDirection",
    DROP COLUMN "gpsSpeed"`.execute(db);
}
