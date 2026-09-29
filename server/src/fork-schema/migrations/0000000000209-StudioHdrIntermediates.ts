import { Kysely, sql } from 'kysely';

/**
 * FL-97: the Studio HDR intermediate of an HDR video, a Frameleaf-only derivative (10-bit AV1,
 * BT.2020 PQ/HLG, no metadata) that the editor decodes for real HDR pixels. It lives here, not in
 * the official `asset_file`, so a handoff leaves official data untouched. Like the video edit
 * versions it has no foreign key into public: the asset's deletion takes the row and file, the
 * return archives rows orphaned meanwhile, and the nightly sweep releases rows whose original
 * changed (`sourceFingerprint`), that an edit now covers, or that no project used for 30 days.
 * A refusal (`ineligible`, `failed`) is kept too, so the same original is not transcoded again on
 * every project read.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE immich_fork.studio_hdr_intermediate (
      "assetId" uuid NOT NULL,
      "ownerId" uuid NOT NULL,
      "sourceFingerprint" bytea NOT NULL,
      status text NOT NULL,
      path text,
      "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      "lastUsedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT studio_hdr_intermediate_pkey PRIMARY KEY ("assetId"),
      CONSTRAINT studio_hdr_intermediate_path_uq UNIQUE (path),
      CONSTRAINT studio_hdr_intermediate_status_check CHECK (status IN ('ready', 'ineligible', 'failed')),
      CONSTRAINT studio_hdr_intermediate_path_check CHECK ((status = 'ready') = (path IS NOT NULL))
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE immich_fork.studio_hdr_intermediate`.execute(db);
}
