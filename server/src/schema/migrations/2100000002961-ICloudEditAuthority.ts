import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE public.icloud_edit_authority (
    "ownerId" uuid NOT NULL REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE,
    item text NOT NULL, generation integer NOT NULL CONSTRAINT icloud_edit_authority_generation_check CHECK (generation>0),
    holder text NOT NULL, "sourceIncarnation" uuid NOT NULL, "currentVersionId" uuid NOT NULL,
    "baselineDecisionId" uuid NOT NULL, PRIMARY KEY ("ownerId",item)
  )`.execute(db);
  await sql`CREATE TABLE public.icloud_edit_version (
    id uuid PRIMARY KEY, "ownerId" uuid NOT NULL REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE,
    item text NOT NULL, "assetId" uuid NOT NULL, sha256 bytea NOT NULL, "isOriginal" boolean NOT NULL,
    CONSTRAINT icloud_edit_version_asset_uq UNIQUE ("ownerId",item,"assetId"),
    CONSTRAINT icloud_edit_version_digest_check CHECK (octet_length(sha256)=32)
  )`.execute(db);
  await sql`CREATE TABLE public.icloud_edit_alias (
    "ownerId" uuid NOT NULL REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE,
    item text NOT NULL, holder text NOT NULL, "sourceIncarnation" uuid NOT NULL, "nativeVersion" text NOT NULL,
    "versionId" uuid NOT NULL REFERENCES public.icloud_edit_version(id) ON UPDATE CASCADE ON DELETE CASCADE,
    PRIMARY KEY ("ownerId",item,holder,"sourceIncarnation","nativeVersion")
  )`.execute(db);
  await sql`CREATE TABLE public.icloud_edit_decision (
    id uuid PRIMARY KEY, "ownerId" uuid NOT NULL REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE,
    item text NOT NULL, kind text NOT NULL CONSTRAINT icloud_edit_decision_kind_check CHECK (kind IN ('baseline','successor')),
    generation integer NOT NULL, "versionId" uuid NOT NULL, evidence jsonb NOT NULL,
    channel text, "resourceId" uuid, "assetId" uuid, events jsonb NOT NULL,
    CONSTRAINT icloud_edit_decision_resource_uq UNIQUE ("ownerId",channel,"resourceId")
  )`.execute(db);
}
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE public.icloud_edit_decision, public.icloud_edit_alias,
    public.icloud_edit_version, public.icloud_edit_authority`.execute(db);
}
