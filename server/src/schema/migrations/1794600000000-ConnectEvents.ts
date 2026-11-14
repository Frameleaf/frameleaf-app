import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE connect_event_stream (
    "ownerId" uuid PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE ON UPDATE CASCADE,
    position bigint NOT NULL DEFAULT 0,
    "prunedThrough" bigint NOT NULL DEFAULT 0)`.execute(db);
  await sql`CREATE TABLE connect_event (
    "ownerId" uuid NOT NULL REFERENCES connect_event_stream("ownerId") ON DELETE CASCADE ON UPDATE CASCADE,
    position bigint NOT NULL,
    "deliveryId" uuid NOT NULL DEFAULT gen_random_uuid(),
    "sourceId" character varying NOT NULL,
    event character varying NOT NULL,
    "assetId" uuid NOT NULL,
    "albumId" uuid,
    "versionId" uuid,
    format character varying,
    "occurredAt" timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY("ownerId",position),
    CONSTRAINT connect_event_source_key UNIQUE("ownerId","sourceId"),
    CONSTRAINT connect_event_delivery_key UNIQUE("deliveryId"))`.execute(db);
  await sql`CREATE INDEX connect_event_retention_idx ON connect_event ("occurredAt")`.execute(db);
  await sql`CREATE TABLE connect_asset_ready (
    "assetId" uuid PRIMARY KEY REFERENCES asset(id) ON DELETE CASCADE ON UPDATE CASCADE)`.execute(db);
  await sql`CREATE TABLE connect_event_cursor (
    "tokenHash" bytea PRIMARY KEY,"ownerId" uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE ON UPDATE CASCADE,"grantId" uuid NOT NULL REFERENCES oauth_grant(id) ON DELETE CASCADE ON UPDATE CASCADE,binding character varying NOT NULL,mode character varying NOT NULL,type character varying,"albumId" uuid,position bigint NOT NULL,floor bigint NOT NULL,ceiling bigint,remaining integer,"expiresAt" timestamp with time zone NOT NULL)`.execute(db);
  await sql`CREATE INDEX connect_event_cursor_expiry_idx ON connect_event_cursor ("expiresAt")`.execute(db);
  await sql`CREATE FUNCTION connect_event_append(p_owner uuid,p_source text,p_event text,p_asset uuid,p_album uuid,p_version uuid,p_format text) RETURNS void LANGUAGE plpgsql AS $function$
    DECLARE next_position bigint;
    BEGIN
      INSERT INTO connect_event_stream ("ownerId") VALUES (p_owner) ON CONFLICT DO NOTHING;
      PERFORM 1 FROM connect_event_stream WHERE "ownerId"=p_owner FOR UPDATE;
      IF EXISTS (SELECT 1 FROM connect_event WHERE "ownerId"=p_owner AND "sourceId"=p_source) THEN RETURN; END IF;
      UPDATE connect_event_stream SET position=position+1 WHERE "ownerId"=p_owner RETURNING position INTO next_position;
      INSERT INTO connect_event ("ownerId",position,"sourceId",event,"assetId","albumId","versionId",format)
        VALUES (p_owner,next_position,p_source,p_event,p_asset,p_album,p_version,p_format);
    END$function$`.execute(db);
  await sql`CREATE FUNCTION connect_event_asset_ready() RETURNS TRIGGER LANGUAGE plpgsql AS $function$
    DECLARE asset_owner uuid; ready_id uuid;
    BEGIN
      IF TG_TABLE_NAME='asset_file' THEN
        IF NEW.type NOT IN ('preview','thumbnail') OR NEW."isEdited" THEN RETURN NEW; END IF;
      ELSIF TG_TABLE_NAME='asset_job_status' THEN
        -- Only a newly set metadataExtractedAt can make an asset ready; other status writes skip the asset lock.
        IF NEW."metadataExtractedAt" IS NULL THEN RETURN NEW; END IF;
        IF TG_OP='UPDATE' THEN
          IF OLD."metadataExtractedAt" IS NOT NULL THEN RETURN NEW; END IF;
        END IF;
      END IF;
      SELECT "ownerId" INTO asset_owner FROM asset WHERE id=NEW."assetId" AND type IN ('IMAGE','VIDEO') FOR NO KEY UPDATE;
      IF asset_owner IS NULL THEN RETURN NEW; END IF;
      IF EXISTS (SELECT 1 FROM asset_job_status WHERE "assetId"=NEW."assetId" AND "metadataExtractedAt" IS NOT NULL)
        AND EXISTS (SELECT 1 FROM asset_file WHERE "assetId"=NEW."assetId" AND type='preview' AND NOT "isEdited" AND path<>'')
        AND EXISTS (SELECT 1 FROM asset_file WHERE "assetId"=NEW."assetId" AND type='thumbnail' AND NOT "isEdited" AND path<>'') THEN
        INSERT INTO connect_asset_ready ("assetId") VALUES (NEW."assetId") ON CONFLICT DO NOTHING RETURNING "assetId" INTO ready_id;
        IF ready_id IS NOT NULL THEN
          PERFORM connect_event_append(asset_owner,'asset.ready:'||ready_id,'asset.ready',ready_id,NULL,NULL,NULL);
        END IF;
      END IF;
      RETURN NEW;
    END$function$`.execute(db);
  await sql`CREATE FUNCTION connect_event_album_added() RETURNS TRIGGER LANGUAGE plpgsql AS $function$
    DECLARE asset_owner uuid;
    BEGIN
      SELECT "ownerId" INTO asset_owner FROM asset WHERE id=NEW."assetId";
      PERFORM connect_event_append(asset_owner,'album.asset.added:'||NEW."albumId"||':'||NEW."assetId"||':'||NEW."updateId",
        'album.asset.added',NEW."assetId",NEW."albumId",NULL,NULL);
      RETURN NEW;
    END$function$`.execute(db);
  await sql`CREATE FUNCTION connect_event_studio_published() RETURNS TRIGGER LANGUAGE plpgsql AS $function$
    DECLARE export_format text;
    BEGIN
      IF NEW.state<>'published' OR NEW.scope IS DISTINCT FROM 'library' OR NEW."resultAssetId" IS NULL THEN RETURN NEW; END IF;
      IF TG_OP='UPDATE' AND OLD.state='published' AND OLD.scope='library' AND OLD."resultAssetId" IS NOT NULL THEN RETURN NEW; END IF;
      export_format := CASE WHEN NEW."outputContentType" IN ('image/jpeg','image/heic','video/mp4','video/webm','video/quicktime','video/x-matroska') THEN NEW."outputContentType" ELSE NULL END;
      PERFORM connect_event_append(NEW."ownerId",'studio.export.completed:'||NEW.id,'studio.export.completed',NEW."resultAssetId",NULL,NEW.id,export_format);
      RETURN NEW;
    END$function$`.execute(db);
  await sql`CREATE TRIGGER connect_event_asset_file_ready AFTER INSERT OR UPDATE ON asset_file FOR EACH ROW EXECUTE FUNCTION connect_event_asset_ready()`.execute(db);
  await sql`CREATE TRIGGER connect_event_metadata_ready AFTER INSERT OR UPDATE ON asset_job_status FOR EACH ROW EXECUTE FUNCTION connect_event_asset_ready()`.execute(db);
  await sql`CREATE TRIGGER connect_event_album_added AFTER INSERT ON album_asset FOR EACH ROW EXECUTE FUNCTION connect_event_album_added()`.execute(db);
  await sql`CREATE TRIGGER connect_event_studio_published AFTER INSERT OR UPDATE ON studio_export_version FOR EACH ROW EXECUTE FUNCTION connect_event_studio_published()`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TRIGGER connect_event_asset_file_ready ON asset_file`.execute(db);
  await sql`DROP TRIGGER connect_event_metadata_ready ON asset_job_status`.execute(db);
  await sql`DROP TRIGGER connect_event_album_added ON album_asset`.execute(db);
  await sql`DROP TRIGGER connect_event_studio_published ON studio_export_version`.execute(db);
  await sql`DROP FUNCTION connect_event_asset_ready()`.execute(db);
  await sql`DROP FUNCTION connect_event_album_added()`.execute(db);
  await sql`DROP FUNCTION connect_event_studio_published()`.execute(db);
  await sql`DROP FUNCTION connect_event_append(uuid,text,text,uuid,uuid,uuid,text)`.execute(db);
  await sql`DROP TABLE connect_event_cursor, connect_asset_ready, connect_event, connect_event_stream`.execute(db);
}
