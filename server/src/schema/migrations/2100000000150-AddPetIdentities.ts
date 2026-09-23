import { Kysely, sql } from 'kysely';

/**
 * FL-58 — pet identities and recognition review.
 *
 * `pet` and `pet_observation` are durable owner data. `pet_detection` and
 * `pet_candidate` are the replaceable model side: a recognition run may delete every
 * row in them and rebuild it. The foreign keys only cascade from the replaceable side
 * to the replaceable side, so reprocessing can never remove a durable observation.
 *
 * No triggers and no partial indexes here on purpose, so the migration needs no
 * `migration_overrides` rows; `updatedAt` is written explicitly by `PetRepository`.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "pet" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "ownerId" uuid NOT NULL,
  "name" character varying NOT NULL DEFAULT '',
  "species" character varying NOT NULL DEFAULT 'other',
  "birthDate" date,
  "featuredAssetId" uuid,
  "isHidden" boolean NOT NULL DEFAULT false,
  "isFavorite" boolean NOT NULL DEFAULT false,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pet_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "pet_featuredAssetId_fkey" FOREIGN KEY ("featuredAssetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "pet_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "pet_ownerId_idx" ON "pet" ("ownerId");`.execute(db);
  await sql`CREATE INDEX "pet_featuredAssetId_idx" ON "pet" ("featuredAssetId");`.execute(db);
  await sql`CREATE INDEX "pet_ownerId_isHidden_idx" ON "pet" ("ownerId", "isHidden");`.execute(db);

  await sql`CREATE TABLE "pet_observation" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "petId" uuid NOT NULL,
  "assetId" uuid NOT NULL,
  "state" character varying NOT NULL DEFAULT 'confirmed',
  "source" character varying NOT NULL DEFAULT 'manual',
  "boundingBoxX1" integer,
  "boundingBoxY1" integer,
  "boundingBoxX2" integer,
  "boundingBoxY2" integer,
  "imageWidth" integer,
  "imageHeight" integer,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pet_observation_petId_fkey" FOREIGN KEY ("petId") REFERENCES "pet" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "pet_observation_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "pet_observation_petId_assetId_uq" UNIQUE ("petId", "assetId"),
  CONSTRAINT "pet_observation_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "pet_observation_assetId_idx" ON "pet_observation" ("assetId");`.execute(db);

  await sql`CREATE TABLE "pet_detection" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "assetId" uuid NOT NULL,
  "boundingBoxX1" integer NOT NULL DEFAULT 0,
  "boundingBoxY1" integer NOT NULL DEFAULT 0,
  "boundingBoxX2" integer NOT NULL DEFAULT 0,
  "boundingBoxY2" integer NOT NULL DEFAULT 0,
  "imageWidth" integer NOT NULL DEFAULT 0,
  "imageHeight" integer NOT NULL DEFAULT 0,
  "species" character varying,
  "score" double precision NOT NULL DEFAULT 0,
  "modelName" character varying NOT NULL,
  "modelRevision" character varying NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pet_detection_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "pet_detection_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "pet_detection_assetId_idx" ON "pet_detection" ("assetId");`.execute(db);
  await sql`CREATE INDEX "pet_detection_modelName_modelRevision_idx" ON "pet_detection" ("modelName", "modelRevision");`.execute(
    db,
  );

  await sql`CREATE TABLE "pet_candidate" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "detectionId" uuid NOT NULL,
  "petId" uuid NOT NULL,
  "score" double precision NOT NULL DEFAULT 0,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pet_candidate_detectionId_fkey" FOREIGN KEY ("detectionId") REFERENCES "pet_detection" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "pet_candidate_petId_fkey" FOREIGN KEY ("petId") REFERENCES "pet" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "pet_candidate_detectionId_petId_uq" UNIQUE ("detectionId", "petId"),
  CONSTRAINT "pet_candidate_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "pet_candidate_petId_idx" ON "pet_candidate" ("petId");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "pet_candidate";`.execute(db);
  await sql`DROP TABLE "pet_detection";`.execute(db);
  await sql`DROP TABLE "pet_observation";`.execute(db);
  await sql`DROP TABLE "pet";`.execute(db);
}
