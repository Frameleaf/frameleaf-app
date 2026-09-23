import { Kysely, sql } from 'kysely';

/**
 * Still-image develop revisions (FL-113). Each row is one saved version of an asset's edit
 * recipe together with the render state and the paths of the files that render produced.
 * The original asset file is never referenced here and never rewritten: a revision renders
 * from the original plus its recipe into a new edited master and preview.
 *
 * Fork-owned, so it lives in `immich_fork` and does not foreign-key into the official schema
 * (like `album_metadata`); the develop service clears rows and files on `AssetDelete`.
 *
 * FL-64 (edited in place before the first deployment, as the handoff allows for unreleased fork
 * migrations): `kind` separates server-rendered recipes from files developed in another
 * application and brought back; `sourceChecksum` is the SHA-256 of the original the version was
 * made from, `renditionChecksum` the SHA-256 of its edited master, and `exportId` the recorded
 * export of the original an imported file answers (`public.develop_export`, no foreign key across
 * schemas). `attempts` counts renders so a failure gets exactly one automatic retry.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE immich_fork.asset_develop_revision (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "assetId" uuid NOT NULL,
      "ownerId" uuid NOT NULL,
      revision integer NOT NULL CHECK (revision >= 1),
      "recipeVersion" integer NOT NULL DEFAULT 1,
      recipe jsonb NOT NULL CHECK (jsonb_typeof(recipe) = 'object'),
      label text CHECK (label IS NULL OR length(label) BETWEEN 1 AND 120),
      status text NOT NULL DEFAULT 'saved'
        CHECK (status = ANY (ARRAY['saved'::text, 'queued'::text, 'rendering'::text, 'rendered'::text, 'failed'::text, 'cancelled'::text])),
      progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
      "cancelRequested" boolean NOT NULL DEFAULT false,
      error text,
      "rendererVersion" text,
      "masterPath" text,
      "previewPath" text,
      width integer,
      height integer,
      "isCurrent" boolean NOT NULL DEFAULT false,
      kind text NOT NULL DEFAULT 'recipe' CHECK (kind = ANY (ARRAY['recipe'::text, 'external'::text])),
      "sourceChecksum" bytea,
      "renditionChecksum" bytea,
      "exportId" uuid,
      "fileName" text CHECK ("fileName" IS NULL OR length("fileName") BETWEEN 1 AND 255),
      software text CHECK (software IS NULL OR length(software) BETWEEN 1 AND 120),
      attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      "renderedAt" timestamptz,
      UNIQUE ("assetId", revision)
    )
  `.execute(db);
  await sql`
    CREATE INDEX asset_develop_revision_asset_idx
    ON immich_fork.asset_develop_revision ("assetId", revision DESC)
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX asset_develop_revision_current_idx
    ON immich_fork.asset_develop_revision ("assetId") WHERE "isCurrent"
  `.execute(db);
  await sql`
    CREATE INDEX asset_develop_revision_owner_idx
    ON immich_fork.asset_develop_revision ("ownerId")
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS immich_fork.asset_develop_revision`.execute(db);
}
