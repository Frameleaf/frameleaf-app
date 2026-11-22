import { Kysely, sql } from 'kysely';

/** FL-949: places a person named ("Home", "Grandma's"), each a centre and a radius. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "user_place" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "ownerId" uuid NOT NULL,
  "name" character varying(80) NOT NULL,
  "latitude" double precision NOT NULL,
  "longitude" double precision NOT NULL,
  "radiusMeters" integer NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "user_place_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "user_place_radiusMeters_check" CHECK ("radiusMeters" >= 25 AND "radiusMeters" <= 5000),
  CONSTRAINT "user_place_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE UNIQUE INDEX "user_place_ownerId_name_uq" ON "user_place" ("ownerId", lower(name));`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "user_place";`.execute(db);
}
