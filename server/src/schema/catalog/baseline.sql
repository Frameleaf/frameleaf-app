SET LOCAL standard_conforming_strings = on;
SET LOCAL check_function_bodies = false;
SET LOCAL search_path = public, pg_catalog;

CREATE EXTENSION IF NOT EXISTS cube WITH SCHEMA public;

COMMENT ON EXTENSION cube IS 'data type for multidimensional cubes';

CREATE EXTENSION IF NOT EXISTS earthdistance WITH SCHEMA public;

COMMENT ON EXTENSION earthdistance IS 'calculate great-circle distances on the surface of the Earth';

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';

CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;

COMMENT ON EXTENSION unaccent IS 'text search dictionary that removes accents';

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;

COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';

CREATE TYPE public.album_user_role_enum AS ENUM (
    'owner',
    'editor',
    'viewer'
);

CREATE TYPE public.asset_checksum_algorithm_enum AS ENUM (
    'sha1',
    'sha1-path',
    'sha256'
);

CREATE TYPE public.asset_visibility_enum AS ENUM (
    'archive',
    'timeline',
    'hidden',
    'locked'
);

CREATE TYPE public.assets_status_enum AS ENUM (
    'active',
    'trashed',
    'deleted'
);

CREATE TYPE public.sourcetype AS ENUM (
    'machine-learning',
    'exif',
    'manual'
);

CREATE TYPE public.video_stream_variant_codec_enum AS ENUM (
    'av1',
    'hevc',
    'h264'
);

CREATE FUNCTION public.album_asset_delete_audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      INSERT INTO album_asset_audit ("albumId", "assetId")
      SELECT "albumId", "assetId" FROM OLD
      WHERE "albumId" IN (SELECT "id" FROM album WHERE "id" IN (SELECT "albumId" FROM OLD));
      RETURN NULL;
    END
  $$;

CREATE FUNCTION public.album_parent_cycle_check() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      -- Setting parent to self is always a cycle.
      IF NEW."parentId" IS NOT NULL AND NEW."parentId" = NEW.id THEN
        RAISE EXCEPTION 'Album % cannot be its own parent', NEW.id;
      END IF;
      -- New parent must not already be a descendant of this album (excluding the
      -- self-row, which is always present per closure semantics).
      IF NEW."parentId" IS NOT NULL AND EXISTS (
        SELECT 1
        FROM album_closure
        WHERE id_ancestor = NEW.id
          AND id_descendant = NEW."parentId"
          AND id_ancestor <> id_descendant
      ) THEN
        RAISE EXCEPTION 'Album % cannot have % as parent (would create a cycle)', NEW.id, NEW."parentId";
      END IF;
      RETURN NEW;
    END
  $$;

CREATE FUNCTION public.album_user_after_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      UPDATE album SET "updatedAt" = clock_timestamp(), "updateId" = immich_uuid_v7(clock_timestamp())
      WHERE "id" IN (SELECT "albumId" FROM inserted_rows)
        AND NOT EXISTS (SELECT FROM inserted_rows WHERE role = 'owner');
      RETURN NULL;
    END
  $$;

CREATE FUNCTION public.album_user_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      DELETE FROM "album"
      WHERE "album"."id" = OLD."albumId"
      AND NOT EXISTS (SELECT "albumId" FROM "album_user" WHERE "album_user"."albumId" = "album"."id" AND "album_user"."role" = 'owner');

      RETURN NULL;
    END
  $$;

CREATE FUNCTION public.album_user_delete_audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      INSERT INTO album_audit ("albumId", "userId")
      SELECT "albumId", "userId"
      FROM OLD;

      IF pg_trigger_depth() = 1 THEN
        INSERT INTO album_user_audit ("albumId", "userId")
        SELECT "albumId", "userId"
        FROM OLD;
      END IF;

      RETURN NULL;
    END
  $$;

CREATE FUNCTION public.asset_backup_deletion_capture() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
  INSERT INTO asset_backup_deletion ("assetId", "ownerId", "deletedAt", visibility, "wasLocked", checksum, "checksumAlgorithm", "livePhotoVideoId", "evidenceVersion", "modernPrivacyEvidenceUnavailable")
  VALUES (OLD.id, OLD."ownerId", clock_timestamp(), OLD.visibility::text,
    EXISTS (SELECT 1 FROM asset_lock WHERE "assetId" = OLD.id)
    OR (OLD.visibility::text = 'hidden' AND (
      EXISTS (SELECT 1 FROM asset AS parent JOIN asset_lock ON asset_lock."assetId" = parent.id
        WHERE parent."livePhotoVideoId" = OLD.id AND parent."ownerId" = OLD."ownerId")
      OR EXISTS (SELECT 1 FROM asset_backup_deletion AS parent
        WHERE parent."livePhotoVideoId" = OLD.id AND parent."ownerId" = OLD."ownerId" AND parent."wasLocked")
    )),
    OLD.checksum, OLD."checksumAlgorithm"::text, OLD."livePhotoVideoId", 1, true)
  ON CONFLICT ("assetId") DO UPDATE SET
    "ownerId" = EXCLUDED."ownerId", "deletedAt" = EXCLUDED."deletedAt", visibility = EXCLUDED.visibility,
    "wasLocked" = EXCLUDED."wasLocked", checksum = EXCLUDED.checksum, "checksumAlgorithm" = EXCLUDED."checksumAlgorithm",
    "livePhotoVideoId" = EXCLUDED."livePhotoVideoId", "evidenceVersion" = EXCLUDED."evidenceVersion",
    "modernPrivacyEvidenceUnavailable" = EXCLUDED."modernPrivacyEvidenceUnavailable";
  RETURN OLD;
END
  $$;

CREATE FUNCTION public.asset_delete_audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      INSERT INTO asset_audit ("assetId", "ownerId")
      SELECT "id", "ownerId"
      FROM OLD;
      RETURN NULL;
    END
  $$;

CREATE FUNCTION public.asset_edit_audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      INSERT INTO asset_edit_audit ("editId", "assetId")
      SELECT "id", "assetId"
      FROM OLD;
      RETURN NULL;
    END
  $$;

CREATE FUNCTION public.asset_edit_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      UPDATE asset
      SET "isEdited" = false
      FROM deleted_edit
      WHERE asset.id = deleted_edit."assetId" AND asset."isEdited"
        AND NOT EXISTS (SELECT FROM asset_edit edit WHERE edit."assetId" = asset.id);
      RETURN NULL;
    END
  $$;

CREATE FUNCTION public.asset_edit_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      UPDATE asset
      SET "isEdited" = true
      FROM inserted_edit
      WHERE asset.id = inserted_edit."assetId" AND NOT asset."isEdited";
      RETURN NULL;
    END
  $$;

CREATE FUNCTION public.asset_face_audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      INSERT INTO asset_face_audit ("assetFaceId", "assetId")
      SELECT "id", "assetId"
      FROM OLD;
      RETURN NULL;
    END
  $$;

CREATE FUNCTION public.asset_metadata_audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      INSERT INTO asset_metadata_audit ("assetId", "key")
      SELECT "assetId", "key"
      FROM OLD;
      RETURN NULL;
    END
  $$;

CREATE FUNCTION public.asset_ocr_delete_audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      INSERT INTO asset_ocr_audit ("assetId")
      SELECT "assetId"
      FROM OLD;
      RETURN NULL;
    END
  $$;

CREATE FUNCTION public.f_concat_ws(text, text[]) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $_$SELECT array_to_string($2, $1)$_$;

CREATE FUNCTION public.f_unaccent(text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    RETURN public.unaccent('public.unaccent'::regdictionary, $1);

CREATE FUNCTION public.freeze_icloud_weekly_bindings() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF TG_TABLE_NAME='icloud_weekly_cohort' THEN
        IF (to_jsonb(NEW)-ARRAY['performedCount','matchCount','mismatchCount','unavailableCount','cancelledCount','nextBatch','status'])
          IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['performedCount','matchCount','mismatchCount','unavailableCount','cancelledCount','nextBatch','status'])
          THEN RAISE EXCEPTION 'icloud_weekly_cohort_frozen'; END IF;
      ELSE
        IF (to_jsonb(NEW)-ARRAY['outcome','auditRequestId']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['outcome','auditRequestId'])
          THEN RAISE EXCEPTION 'icloud_weekly_member_frozen'; END IF;
        IF OLD.outcome<>'pending' AND NEW.outcome IS DISTINCT FROM OLD.outcome
          THEN RAISE EXCEPTION 'icloud_weekly_outcome_frozen'; END IF;
        IF OLD."auditRequestId" IS NOT NULL AND NEW."auditRequestId" IS DISTINCT FROM OLD."auditRequestId"
          THEN RAISE EXCEPTION 'icloud_weekly_audit_binding_frozen'; END IF;
      END IF;
      RETURN NEW;
    END $$;

CREATE FUNCTION public.icloud_connection_unhealthy_since() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.state = 'connected' THEN
        NEW."unhealthySince" := NULL;
      ELSIF NEW."unhealthySince" IS NULL THEN
        NEW."unhealthySince" := now();
      END IF;
      RETURN NEW;
    END
    $$;

CREATE FUNCTION public.immich_uuid_v7(p_timestamp timestamp with time zone DEFAULT clock_timestamp()) RETURNS uuid
    LANGUAGE sql
    AS $$
    SELECT encode(
      set_bit(
        set_bit(
          overlay(uuid_send(gen_random_uuid())
                  placing substring(int8send(floor(extract(epoch from p_timestamp) * 1000)::bigint) from 3)
                  from 1 for 6
          ),
          52, 1
        ),
        53, 1
      ),
      'hex')::uuid;
  $$;

CREATE FUNCTION public.ll_to_earth_public(latitude double precision, longitude double precision) RETURNS public.earth
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$SELECT public.cube(public.cube(public.cube(public.earth()*cos(radians(latitude))*cos(radians(longitude))),public.earth()*cos(radians(latitude))*sin(radians(longitude))),public.earth()*sin(radians(latitude)))::public.earth$$;

CREATE FUNCTION public.media_health_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      new."updatedAt" = clock_timestamp();
      return new;
    END;
  $$;

CREATE FUNCTION public.memory_asset_delete_audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      INSERT INTO memory_asset_audit ("memoryId", "assetId")
      SELECT "memoriesId", "assetId" FROM OLD
      WHERE "memoriesId" IN (SELECT "id" FROM memory WHERE "id" IN (SELECT "memoriesId" FROM OLD));
      RETURN NULL;
    END
  $$;

CREATE FUNCTION public.memory_delete_audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      INSERT INTO memory_audit ("memoryId", "userId")
      SELECT "id", "ownerId"
      FROM OLD;
      RETURN NULL;
    END
  $$;

CREATE FUNCTION public.partner_delete_audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      INSERT INTO partner_audit ("sharedById", "sharedWithId")
      SELECT "sharedById", "sharedWithId"
      FROM OLD;
      RETURN NULL;
    END
  $$;

CREATE FUNCTION public.person_delete_audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      INSERT INTO person_audit ("personGroupId", "ownerId")
      SELECT "personGroupId", "ownerId"
      FROM OLD;
      RETURN NULL;
    END
  $$;

CREATE FUNCTION public.person_group_delete_audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      INSERT INTO person_group_audit ("personGroupId", "clusterGroupId")
      SELECT "id", "clusterGroupId"
      FROM OLD;
      RETURN NULL;
    END
  $$;

CREATE FUNCTION public.pet_delete_audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$BEGIN INSERT INTO pet_audit ("petId", "ownerId") SELECT id, "ownerId" FROM OLD; RETURN NULL; END$$;

CREATE FUNCTION public.pet_observation_delete_audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
 INSERT INTO pet_observation_audit ("observationId", "petId", "assetId", "ownerId")
 SELECT deleted.id, deleted."petId", deleted."assetId", coalesce(pet."ownerId", asset."ownerId")
 FROM OLD AS deleted LEFT JOIN pet ON pet.id = deleted."petId" LEFT JOIN asset ON asset.id = deleted."assetId"
 WHERE coalesce(pet."ownerId", asset."ownerId") IS NOT NULL
 AND (pet."ownerId" IS NULL OR asset."ownerId" IS NULL OR pet."ownerId" = asset."ownerId");
 RETURN NULL; END
  $$;

CREATE FUNCTION public.pet_observation_update_id() RETURNS trigger
    LANGUAGE plpgsql
    AS $$BEGIN NEW."updateId" := immich_uuid_v7(); RETURN NEW; END$$;

CREATE FUNCTION public.pet_update_id() RETURNS trigger
    LANGUAGE plpgsql
    AS $$BEGIN NEW."updateId" := immich_uuid_v7(); RETURN NEW; END$$;

CREATE FUNCTION public.retire_icloud_weekly_authority() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE old_row jsonb; new_row jsonb; owner_id uuid; connection_id uuid; changed boolean;
    BEGIN
      old_row := CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
      new_row := CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
      IF TG_TABLE_NAME='icloud_connection' THEN
        owner_id := (new_row->>'ownerId')::uuid; connection_id := (new_row->>'id')::uuid;
        changed := old_row->'config' IS DISTINCT FROM new_row->'config'
          OR (old_row->'encryptedSession' IS DISTINCT FROM new_row->'encryptedSession'
            AND new_row->>'encryptedSession' IS NULL)
          OR (new_row->>'lastError'='owner_removed' AND old_row->>'lastError' IS DISTINCT FROM 'owner_removed')
          OR (old_row->>'state' IS DISTINCT FROM new_row->>'state' AND new_row->>'state'<>'connected');
      ELSIF TG_TABLE_NAME='user' THEN
        owner_id := coalesce(new_row->>'id',old_row->>'id')::uuid;
        changed := TG_OP='DELETE' OR old_row->'pinCode' IS DISTINCT FROM new_row->'pinCode'
          OR old_row->'deletedAt' IS DISTINCT FROM new_row->'deletedAt';
      ELSE
        owner_id := coalesce(new_row->>'userId',old_row->>'userId')::uuid;
        changed := coalesce(new_row->>'key',old_row->>'key')='preferences'
          AND old_row->'value'->'privacy' IS DISTINCT FROM new_row->'value'->'privacy';
      END IF;
      IF changed THEN
        UPDATE public.icloud_weekly_grant SET enabled=false,"includeProtected"=false,
          "pinBinding"=NULL,generation=generation+1,"revokedAt"=clock_timestamp()
          WHERE "ownerId"=owner_id AND (connection_id IS NULL OR "connectionId"=connection_id) AND enabled;
      END IF;
      RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
    END $$;

CREATE FUNCTION public.stack_delete_audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      INSERT INTO stack_audit ("stackId", "userId")
      SELECT "id", "ownerId"
      FROM OLD;
      RETURN NULL;
    END
  $$;

CREATE FUNCTION public.tag_asset_delete_audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
    INSERT INTO tag_asset_audit ("tagId", "assetId", "userId")
    SELECT deleted."tagId", deleted."assetId", coalesce(tag."userId", asset."ownerId")
    FROM OLD AS deleted LEFT JOIN tag ON tag.id = deleted."tagId" LEFT JOIN asset ON asset.id = deleted."assetId"
    WHERE coalesce(tag."userId", asset."ownerId") IS NOT NULL
      AND (tag."userId" IS NULL OR asset."ownerId" IS NULL OR tag."userId" = asset."ownerId");
    RETURN NULL; END
  $$;

CREATE FUNCTION public.tag_asset_update_id() RETURNS trigger
    LANGUAGE plpgsql
    AS $$BEGIN NEW."updateId" := immich_uuid_v7(); RETURN NEW; END$$;

CREATE FUNCTION public.tag_delete_audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$BEGIN INSERT INTO tag_audit ("tagId", "userId") SELECT id, "userId" FROM OLD; RETURN NULL; END$$;

CREATE FUNCTION public.updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
        clock_timestamp TIMESTAMP := clock_timestamp();
    BEGIN
        new."updatedAt" = clock_timestamp;
        new."updateId" = immich_uuid_v7(clock_timestamp);
        return new;
    END;
  $$;

CREATE FUNCTION public.user_delete_audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      INSERT INTO user_audit ("userId")
      SELECT "id"
      FROM OLD;
      RETURN NULL;
    END
  $$;

CREATE FUNCTION public.user_metadata_audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      INSERT INTO user_metadata_audit ("userId", "key")
      SELECT "userId", "key"
      FROM OLD;
      RETURN NULL;
    END
  $$;

CREATE TABLE public.activity (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "albumId" uuid NOT NULL,
    "userId" uuid NOT NULL,
    "assetId" uuid,
    comment text,
    "isLiked" boolean DEFAULT false NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    CONSTRAINT activity_like_check CHECK ((((comment IS NULL) AND ("isLiked" = true)) OR ((comment IS NOT NULL) AND ("isLiked" = false))))
);

CREATE TABLE public.admin_audit_event (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "userId" uuid NOT NULL,
    "actorId" uuid,
    "libraryId" uuid,
    action character varying NOT NULL,
    subject character varying NOT NULL,
    detail character varying,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.album (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "albumName" character varying DEFAULT 'Untitled Album'::character varying NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "albumThumbnailAssetId" uuid,
    "parentId" uuid,
    icon character varying,
    "sortOrder" double precision,
    kind text DEFAULT 'album'::text NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    description text,
    "deletedAt" timestamp with time zone,
    "isActivityEnabled" boolean DEFAULT true NOT NULL,
    "order" character varying DEFAULT 'desc'::character varying NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    CONSTRAINT album_kind_check CHECK ((kind = ANY (ARRAY['album'::text, 'collection'::text, 'space'::text])))
);

COMMENT ON COLUMN public.album."albumThumbnailAssetId" IS 'Asset ID to be used as thumbnail';

COMMENT ON COLUMN public.album."parentId" IS 'Parent album ID for nesting (null = top-level)';

CREATE TABLE public.album_asset (
    "albumId" uuid NOT NULL,
    "assetId" uuid NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL
);

CREATE TABLE public.album_asset_audit (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "albumId" uuid NOT NULL,
    "assetId" uuid NOT NULL,
    "deletedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE public.album_audit (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "albumId" uuid NOT NULL,
    "userId" uuid NOT NULL,
    "deletedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE public.album_closure (
    id_ancestor uuid NOT NULL,
    id_descendant uuid NOT NULL
);

CREATE TABLE public.album_cover_follows_newest (
    "albumId" uuid NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE public.album_origin (
    "albumId" uuid NOT NULL,
    "createdAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    following boolean DEFAULT true NOT NULL,
    "overriddenFields" text[] DEFAULT '{}'::text[] NOT NULL,
    "ownerId" uuid NOT NULL,
    "partnerSharedById" uuid NOT NULL,
    "rootOwnerId" uuid NOT NULL,
    "sourceAlbumId" uuid
);

CREATE TABLE public.album_position (
    "albumId" uuid NOT NULL,
    "position" integer NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    "userId" uuid NOT NULL,
    CONSTRAINT album_position_position_check CHECK (("position" >= 0))
);

CREATE TABLE public.album_source_asset (
    "linkId" uuid NOT NULL,
    "assetId" uuid NOT NULL,
    "addedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE public.album_source_link (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "userId" uuid NOT NULL,
    "albumId" uuid NOT NULL,
    "sourceKind" text NOT NULL,
    "sourceId" text NOT NULL,
    "deviceKey" text,
    "lastSourceName" text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT album_source_link_device_check CHECK ((("deviceKey" IS NULL) OR ((length("deviceKey") >= 1) AND (length("deviceKey") <= 256)))),
    CONSTRAINT album_source_link_kind_check CHECK (("sourceKind" = ANY (ARRAY['ios-photos'::text, 'android-folder'::text]))),
    CONSTRAINT album_source_link_source_check CHECK (((length("sourceId") >= 1) AND (length("sourceId") <= 1024)))
);

CREATE TABLE public.album_user (
    "albumId" uuid NOT NULL,
    "userId" uuid NOT NULL,
    role public.album_user_role_enum DEFAULT 'editor'::public.album_user_role_enum NOT NULL,
    "createId" uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.album_user_audit (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "albumId" uuid NOT NULL,
    "userId" uuid NOT NULL,
    "deletedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE public.api_key (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying NOT NULL,
    key bytea NOT NULL,
    "userId" uuid NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    permissions character varying[] NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL
);

CREATE TABLE public.archive_operation (
    "archiveJobId" uuid,
    "createdAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    descriptor jsonb,
    "expiresAt" timestamp with time zone,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "ownerId" uuid NOT NULL,
    prepared boolean DEFAULT false NOT NULL,
    "preparedElevated" boolean DEFAULT false NOT NULL,
    "requestKey" uuid NOT NULL,
    scope text NOT NULL,
    "sessionId" uuid,
    "undoJobId" uuid,
    CONSTRAINT archive_operation_scope_check CHECK ((scope = ANY (ARRAY['selected-owned-assets'::text, 'matching-owned-timeline'::text])))
);

CREATE TABLE public.archive_operation_item (
    "assetId" uuid NOT NULL,
    "operationId" uuid NOT NULL,
    ordinal integer NOT NULL,
    "previousVisibility" text,
    "publishedUpdateId" uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    CONSTRAINT archive_operation_item_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'archived'::text, 'skipped'::text, 'undone'::text, 'conflict'::text])))
);

CREATE TABLE public.asset (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "ownerId" uuid NOT NULL,
    type character varying NOT NULL,
    "originalPath" character varying NOT NULL,
    "physicalOriginalFileId" uuid,
    "fileCreatedAt" timestamp with time zone NOT NULL,
    "fileModifiedAt" timestamp with time zone NOT NULL,
    "isFavorite" boolean DEFAULT false NOT NULL,
    duration integer,
    checksum bytea NOT NULL,
    "checksumAlgorithm" public.asset_checksum_algorithm_enum NOT NULL,
    "livePhotoVideoId" uuid,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "originalFileName" character varying NOT NULL,
    thumbhash bytea,
    "isOffline" boolean DEFAULT false NOT NULL,
    "libraryId" uuid,
    "isExternal" boolean DEFAULT false NOT NULL,
    "deletedAt" timestamp with time zone,
    "localDateTime" timestamp with time zone NOT NULL,
    "stackId" uuid,
    "duplicateId" uuid,
    status public.assets_status_enum DEFAULT 'active'::public.assets_status_enum NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    visibility public.asset_visibility_enum DEFAULT 'timeline'::public.asset_visibility_enum NOT NULL,
    width integer,
    height integer,
    "isEdited" boolean DEFAULT false NOT NULL,
    is_nsfw boolean DEFAULT false NOT NULL
);

CREATE TABLE public.asset_audit (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "assetId" uuid NOT NULL,
    "ownerId" uuid NOT NULL,
    "deletedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE public.asset_backup_deletion (
    "assetId" uuid NOT NULL,
    "ownerId" uuid NOT NULL,
    "deletedAt" timestamp with time zone NOT NULL,
    visibility text NOT NULL,
    "wasLocked" boolean NOT NULL,
    checksum bytea,
    "checksumAlgorithm" text,
    "livePhotoVideoId" uuid,
    "evidenceVersion" integer NOT NULL,
    "modernPrivacyEvidenceUnavailable" boolean NOT NULL
);

CREATE TABLE public.asset_best_photo_score (
    "assetId" uuid NOT NULL,
    "ownerId" uuid NOT NULL,
    score double precision NOT NULL,
    "aestheticScore" double precision,
    "technicalScore" double precision,
    "subjectScore" double precision,
    "diversityScore" double precision,
    "scoreVersion" integer NOT NULL,
    "computedAt" timestamp with time zone NOT NULL,
    metadata jsonb,
    "bestFrameTimestampMs" integer,
    "frameScore" double precision,
    "frameMetadata" jsonb,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.asset_checksum (
    "assetId" uuid NOT NULL,
    evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    "linkCount" integer NOT NULL,
    sha1 bytea NOT NULL,
    sha256 bytea NOT NULL,
    "sizeInBytes" bigint NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "verifiedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "verifiedPaths" text[] NOT NULL,
    CONSTRAINT "asset_checksum_linkCount_check" CHECK (("linkCount" > 0))
);

CREATE TABLE public.asset_develop_artifact (
    "assetId" uuid NOT NULL,
    bytes bigint NOT NULL,
    "createdAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    height integer NOT NULL,
    id text NOT NULL,
    kind text NOT NULL,
    "ownerId" uuid NOT NULL,
    path text NOT NULL,
    width integer NOT NULL,
    CONSTRAINT asset_develop_artifact_id_check CHECK ((id ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT asset_develop_artifact_kind_check CHECK ((kind = ANY (ARRAY['mask'::text, 'fill'::text])))
);

CREATE TABLE public.asset_develop_revision (
    "assetId" uuid NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    "cancelRequested" boolean DEFAULT false NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    error text,
    "exportId" uuid,
    "fileName" text,
    height integer,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "isCurrent" boolean DEFAULT false NOT NULL,
    kind text DEFAULT 'recipe'::text NOT NULL,
    label text,
    "masterPath" text,
    "ownerId" uuid NOT NULL,
    "previewPath" text,
    progress integer DEFAULT 0 NOT NULL,
    recipe jsonb NOT NULL,
    "recipeVersion" integer DEFAULT 1 NOT NULL,
    "renderedAt" timestamp with time zone,
    "rendererVersion" text,
    "renditionChecksum" bytea,
    revision integer NOT NULL,
    software text,
    "sourceChecksum" bytea,
    status text DEFAULT 'saved'::text NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    width integer,
    CONSTRAINT asset_develop_revision_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT "asset_develop_revision_fileName_check" CHECK ((("fileName" IS NULL) OR ((length("fileName") >= 1) AND (length("fileName") <= 255)))),
    CONSTRAINT asset_develop_revision_kind_check CHECK ((kind = ANY (ARRAY['recipe'::text, 'external'::text]))),
    CONSTRAINT asset_develop_revision_label_check CHECK (((label IS NULL) OR ((length(label) >= 1) AND (length(label) <= 120)))),
    CONSTRAINT asset_develop_revision_progress_check CHECK (((progress >= 0) AND (progress <= 100))),
    CONSTRAINT asset_develop_revision_recipe_check CHECK ((jsonb_typeof(recipe) = 'object'::text)),
    CONSTRAINT asset_develop_revision_revision_check CHECK ((revision >= 1)),
    CONSTRAINT asset_develop_revision_software_check CHECK (((software IS NULL) OR ((length(software) >= 1) AND (length(software) <= 120)))),
    CONSTRAINT asset_develop_revision_status_check CHECK ((status = ANY (ARRAY['saved'::text, 'queued'::text, 'rendering'::text, 'rendered'::text, 'failed'::text, 'cancelled'::text])))
);

CREATE TABLE public.asset_document_edit (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "assetId" uuid NOT NULL,
    key character varying NOT NULL,
    action character varying NOT NULL,
    value text,
    "sourceText" text,
    x1 real,
    y1 real,
    x2 real,
    y2 real,
    x3 real,
    y3 real,
    x4 real,
    y4 real,
    revision integer DEFAULT 1 NOT NULL,
    "editedById" uuid,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.asset_edit (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "assetId" uuid NOT NULL,
    action character varying NOT NULL,
    parameters jsonb NOT NULL,
    sequence integer NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL
);

CREATE TABLE public.asset_edit_audit (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "editId" uuid NOT NULL,
    "assetId" uuid NOT NULL,
    "deletedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE public.asset_exif (
    "assetId" uuid NOT NULL,
    make character varying,
    model character varying,
    "exifImageWidth" integer,
    "exifImageHeight" integer,
    "fileSizeInByte" bigint,
    orientation character varying,
    "dateTimeOriginal" timestamp with time zone,
    "modifyDate" timestamp with time zone,
    "lensModel" character varying,
    "fNumber" double precision,
    "focalLength" double precision,
    iso integer,
    latitude double precision,
    longitude double precision,
    city character varying,
    state character varying,
    country character varying,
    description text DEFAULT ''::text NOT NULL,
    fps double precision,
    "exposureTime" character varying,
    "livePhotoCID" character varying,
    "timeZone" character varying,
    "projectionType" character varying,
    "profileDescription" character varying,
    colorspace character varying,
    "bitsPerSample" integer,
    "autoStackId" character varying,
    rating integer,
    tags character varying[],
    "updatedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "lockedProperties" character varying[]
);

CREATE TABLE public.asset_face (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "assetId" uuid NOT NULL,
    "personGroupId" uuid,
    "imageWidth" integer DEFAULT 0 NOT NULL,
    "imageHeight" integer DEFAULT 0 NOT NULL,
    "boundingBoxX1" integer DEFAULT 0 NOT NULL,
    "boundingBoxY1" integer DEFAULT 0 NOT NULL,
    "boundingBoxX2" integer DEFAULT 0 NOT NULL,
    "boundingBoxY2" integer DEFAULT 0 NOT NULL,
    "sourceType" public.sourcetype DEFAULT 'machine-learning'::public.sourcetype NOT NULL,
    "correctedAt" timestamp with time zone,
    "deletedAt" timestamp with time zone,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "isVisible" boolean DEFAULT true NOT NULL
);

CREATE TABLE public.asset_face_audit (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "assetFaceId" uuid NOT NULL,
    "assetId" uuid NOT NULL,
    "deletedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE public.asset_file (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "assetId" uuid NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    type character varying NOT NULL,
    path character varying NOT NULL,
    "physicalFileId" uuid,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "isEdited" boolean DEFAULT false NOT NULL,
    "isProgressive" boolean DEFAULT false NOT NULL,
    "isTransparent" boolean DEFAULT false NOT NULL
);

CREATE TABLE public.asset_health (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "assetId" uuid NOT NULL,
    "runId" uuid,
    category character varying NOT NULL,
    status character varying NOT NULL,
    severity character varying NOT NULL,
    "originalPath" character varying NOT NULL,
    "originalFileName" character varying NOT NULL,
    evidence jsonb NOT NULL,
    resolution jsonb NOT NULL,
    "checkedAt" timestamp with time zone NOT NULL,
    "dismissedAt" timestamp with time zone,
    "resolvedAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.asset_health_candidate (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "healthId" uuid NOT NULL,
    "candidatePath" character varying NOT NULL,
    status character varying NOT NULL,
    "visualMatchScore" double precision,
    evidence jsonb NOT NULL,
    resolution jsonb NOT NULL,
    "checkedAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.asset_health_run (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "ownerId" uuid,
    category character varying NOT NULL,
    status character varying DEFAULT 'running'::character varying NOT NULL,
    "startedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "finishedAt" timestamp with time zone,
    "totalAssets" integer DEFAULT 0 NOT NULL,
    "checkedAssets" integer DEFAULT 0 NOT NULL,
    "foundAssets" integer DEFAULT 0 NOT NULL,
    error text
);

CREATE TABLE public.asset_integrity_verification (
    "assetId" uuid NOT NULL,
    "originalPath" text NOT NULL,
    "expectedChecksum" bytea NOT NULL,
    "checksumAlgorithm" text,
    "actualSha256" text,
    result text NOT NULL,
    "checkedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE public.asset_job_status (
    "assetId" uuid NOT NULL,
    "facesRecognizedAt" timestamp with time zone,
    "metadataExtractedAt" timestamp with time zone,
    "duplicatesDetectedAt" timestamp with time zone,
    "ocrAt" timestamp with time zone
);

CREATE TABLE public.asset_lock (
    "assetId" uuid NOT NULL,
    reason character varying NOT NULL,
    "lockedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "lockedBy" uuid,
    "previousVisibility" public.asset_visibility_enum,
    inherited boolean DEFAULT false NOT NULL
);

CREATE TABLE public.asset_metadata (
    "assetId" uuid NOT NULL,
    key character varying NOT NULL,
    value jsonb NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.asset_metadata_audit (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "assetId" uuid NOT NULL,
    key character varying NOT NULL,
    "deletedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE public.asset_ocr (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "assetId" uuid NOT NULL,
    x1 real NOT NULL,
    y1 real NOT NULL,
    x2 real NOT NULL,
    y2 real NOT NULL,
    x3 real NOT NULL,
    y3 real NOT NULL,
    x4 real NOT NULL,
    y4 real NOT NULL,
    "boxScore" real NOT NULL,
    "textScore" real NOT NULL,
    text text NOT NULL,
    "isVisible" boolean DEFAULT true NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL
);

CREATE TABLE public.asset_ocr_audit (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "assetId" uuid NOT NULL,
    "deletedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE public.asset_origin (
    "assetId" uuid NOT NULL,
    "createdAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    following boolean DEFAULT true NOT NULL,
    "overriddenFields" text[] DEFAULT '{}'::text[] NOT NULL,
    "ownerId" uuid NOT NULL,
    "partnerSharedById" uuid NOT NULL,
    "rootOwnerId" uuid NOT NULL,
    "sourceAssetId" uuid
);

CREATE TABLE public.asset_restoration (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "assetId" uuid NOT NULL,
    "ownerId" uuid NOT NULL,
    revision integer NOT NULL,
    status character varying DEFAULT 'preview_queued'::character varying NOT NULL,
    mode character varying NOT NULL,
    upscale integer DEFAULT 1 NOT NULL,
    "keepGrain" boolean DEFAULT false NOT NULL,
    workload character varying NOT NULL,
    "destinationId" uuid,
    "destinationKind" character varying NOT NULL,
    "destinationName" character varying NOT NULL,
    "sourceType" character varying NOT NULL,
    "sourceChecksum" bytea NOT NULL,
    "sourceWidth" integer NOT NULL,
    "sourceHeight" integer NOT NULL,
    "sourceDurationSeconds" double precision,
    "previewRegion" jsonb NOT NULL,
    "previewOperationId" uuid,
    "fullOperationId" uuid,
    "previewBeforePath" character varying,
    "previewAfterPath" character varying,
    "resultPath" character varying,
    "resultPreviewPath" character varying,
    "outputWidth" integer,
    "outputHeight" integer,
    "modelName" character varying,
    "modelVersion" character varying,
    provenance jsonb DEFAULT '{}'::jsonb NOT NULL,
    estimate jsonb,
    error text,
    "isCurrent" boolean DEFAULT false NOT NULL,
    "previewReadyAt" timestamp with time zone,
    "reviewedAt" timestamp with time zone,
    "restoredAt" timestamp with time zone,
    "previewExpiresAt" timestamp with time zone,
    "resultExpiresAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL
);

CREATE TABLE public.asset_upload_part (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "resourceId" uuid NOT NULL,
    path text NOT NULL,
    "offset" bigint NOT NULL,
    size bigint NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.asset_upload_resource (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "ownerId" uuid,
    metadata jsonb NOT NULL,
    "expectedChecksum" bytea NOT NULL,
    "contentType" text NOT NULL,
    "expectedSize" bigint,
    "offset" bigint DEFAULT 0 NOT NULL,
    "maxSize" bigint NOT NULL,
    "maxAppendSize" bigint NOT NULL,
    state text DEFAULT 'receiving'::text NOT NULL,
    "finalPath" text,
    "verifiedChecksum" bytea,
    "legacyChecksum" bytea,
    "resultAssetId" uuid,
    "resultStatus" text,
    ingested boolean DEFAULT false NOT NULL,
    "ingestionToken" uuid,
    "ingestionLeaseExpiresAt" timestamp with time zone,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.asset_user_share (
    "assetId" uuid NOT NULL,
    "createdAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "ownerId" uuid NOT NULL,
    "sharedWithId" uuid NOT NULL
);

CREATE TABLE public.asset_video_duplicate_frame (
    "assetId" uuid NOT NULL,
    "frameIndex" integer NOT NULL,
    "timestampMs" integer NOT NULL,
    path character varying NOT NULL,
    embedding public.vector(512) NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.backup_device (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "ownerId" uuid NOT NULL,
    "deviceKey" uuid NOT NULL,
    "displayName" text NOT NULL,
    model text NOT NULL,
    platform text NOT NULL,
    "appVersion" text NOT NULL,
    "reportedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    "lastSuccessfulBackupAt" timestamp with time zone,
    "pendingCount" integer NOT NULL,
    "deletedAt" timestamp with time zone
);

CREATE TABLE public.backup_reconciliation (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "deviceId" uuid NOT NULL,
    "ownerId" uuid NOT NULL,
    "startedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    "checkedAt" timestamp with time zone NOT NULL,
    "completedAt" timestamp with time zone,
    "itemsChecked" integer NOT NULL,
    "itemsMissing" integer NOT NULL,
    progress jsonb NOT NULL
);

CREATE TABLE public.buddy_backup_reference (
    "createdAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    "deleteRequested" boolean DEFAULT false NOT NULL,
    path text NOT NULL,
    released boolean DEFAULT false NOT NULL,
    "runId" uuid NOT NULL
);

CREATE TABLE public.classification_match (
    "ruleId" uuid NOT NULL,
    "assetId" uuid NOT NULL,
    score double precision,
    decision character varying NOT NULL,
    "tagContributed" boolean DEFAULT false NOT NULL,
    "archiveContributed" boolean DEFAULT false NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.classification_rule (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "ownerId" uuid NOT NULL,
    "albumId" uuid NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    "personIds" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "tagIds" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "takenAfter" character varying,
    "takenBefore" character varying,
    "mediaType" character varying DEFAULT 'any'::character varying NOT NULL,
    "visualQueries" jsonb DEFAULT '[]'::jsonb NOT NULL,
    threshold double precision DEFAULT 0.25 NOT NULL,
    action character varying DEFAULT 'review'::character varying NOT NULL,
    "tagId" uuid,
    archive boolean DEFAULT false NOT NULL,
    "archiveConsentAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "lastAppliedAt" timestamp with time zone,
    CONSTRAINT classification_rule_archive_consent_chk CHECK (((NOT archive) OR ("archiveConsentAt" IS NOT NULL)))
);

CREATE TABLE public.cloud_backup_manifest (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    bucket text NOT NULL,
    key text NOT NULL,
    "databaseKey" text,
    "operationId" uuid,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "finishedAt" timestamp with time zone,
    "assetCount" integer DEFAULT 0 NOT NULL,
    "fileCount" integer DEFAULT 0 NOT NULL,
    bytes bigint DEFAULT 0 NOT NULL,
    status text DEFAULT 'running'::text NOT NULL
);

CREATE TABLE public.cloud_backup_manifest_entry (
    "manifestId" uuid NOT NULL,
    "fileKey" text NOT NULL,
    "assetId" uuid,
    "ownerId" uuid,
    role text NOT NULL,
    path text NOT NULL,
    sha256 text NOT NULL,
    size bigint NOT NULL,
    mtime timestamp with time zone
);

CREATE TABLE public.cloud_backup_manifest_original (
    "manifestId" uuid NOT NULL,
    "assetId" uuid NOT NULL,
    sha256 text NOT NULL
);

CREATE TABLE public.cloud_backup_object (
    bucket text NOT NULL,
    sha256 text NOT NULL,
    size bigint NOT NULL,
    etag text,
    "uploadedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "lastSeenAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.cloud_backup_object_verification (
    bucket text NOT NULL,
    sha256 text NOT NULL,
    "operationId" uuid NOT NULL,
    method text NOT NULL,
    result text NOT NULL,
    "checkedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE public.cluster_group (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL
);

CREATE TABLE public.cluster_group_request (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "clusterGroupId" uuid NOT NULL,
    "userId" uuid NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.develop_export (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "assetId" uuid NOT NULL,
    "ownerId" uuid NOT NULL,
    "sourceChecksum" bytea NOT NULL,
    "fileName" character varying NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.develop_preset (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "ownerId" uuid NOT NULL,
    name character varying NOT NULL,
    settings jsonb NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.duplicate_decision (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "ownerId" uuid NOT NULL,
    "duplicateId" uuid NOT NULL,
    "operationId" uuid,
    decision character varying NOT NULL,
    "memberIds" jsonb NOT NULL,
    "keepAssetIds" jsonb NOT NULL,
    "trashAssetIds" jsonb NOT NULL,
    "stackId" uuid,
    state jsonb DEFAULT '{}'::jsonb NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "appliedAt" timestamp with time zone,
    "undoOperationId" uuid,
    "undoneAt" timestamp with time zone
);

CREATE TABLE public.face_correction (
    action text NOT NULL,
    "actorId" uuid NOT NULL,
    "assetChecksum" bytea,
    "assetId" uuid,
    "boxX1" double precision,
    "boxX2" double precision,
    "boxY1" double precision,
    "boxY2" double precision,
    "createdAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    "faceId" uuid,
    "fromPersonId" uuid,
    "fromPersonName" text,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "ownerId" uuid NOT NULL,
    "toPersonId" uuid,
    "toPersonName" text,
    "undoneAt" timestamp with time zone,
    CONSTRAINT face_correction_action_check CHECK ((action = ANY (ARRAY['reassign'::text, 'new-person'::text, 'unassign'::text, 'remove'::text, 'merge'::text, 'box-move'::text, 'partner-merge'::text]))),
    CONSTRAINT face_correction_anchor_check CHECK (((action = ANY (ARRAY['merge'::text, 'partner-merge'::text])) OR ("assetId" IS NOT NULL))),
    CONSTRAINT face_correction_box_check CHECK (((("boxX1" IS NULL) AND ("boxY1" IS NULL) AND ("boxX2" IS NULL) AND ("boxY2" IS NULL)) OR (("boxX1" IS NOT NULL) AND ("boxY1" IS NOT NULL) AND ("boxX2" IS NOT NULL) AND ("boxY2" IS NOT NULL))))
);

CREATE TABLE public.face_search (
    "faceId" uuid NOT NULL,
    embedding public.vector(512) NOT NULL
);

CREATE TABLE public.frameleaf_account_link (
    access text,
    "autoRegistered" boolean DEFAULT false NOT NULL,
    email text NOT NULL,
    "emailVerified" boolean DEFAULT false NOT NULL,
    "lastSignInAt" timestamp with time zone,
    "linkedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    role text,
    sub text NOT NULL,
    "userId" uuid NOT NULL,
    CONSTRAINT frameleaf_account_link_access_check CHECK (((access IS NULL) OR (access = ANY (ARRAY['owner'::text, 'admin'::text, 'editor'::text, 'viewer'::text])))),
    CONSTRAINT frameleaf_account_link_role_check CHECK (((role IS NULL) OR (role = ANY (ARRAY['admin'::text, 'user'::text]))))
);

CREATE TABLE public.frameleaf_consent (
    "acceptedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    "acceptedBy" uuid NOT NULL,
    "cloudRecordedVersion" text,
    "destinationId" uuid NOT NULL,
    features jsonb DEFAULT '{}'::jsonb NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "revokedAt" timestamp with time zone,
    version text NOT NULL,
    CONSTRAINT frameleaf_consent_features_check CHECK ((jsonb_typeof(features) = 'object'::text)),
    CONSTRAINT frameleaf_consent_version_check CHECK (((length(version) >= 1) AND (length(version) <= 64)))
);

CREATE TABLE public.frameleaf_exchange_token (
    "expiresAt" timestamp with time zone NOT NULL,
    jti text NOT NULL,
    sub text NOT NULL,
    "usedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE public.frameleaf_immich_import (
    singleton boolean DEFAULT true NOT NULL,
    source_fingerprint text NOT NULL,
    config_fingerprint text NOT NULL,
    source_version text NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    verified_at timestamp with time zone,
    CONSTRAINT frameleaf_immich_import_singleton_check CHECK (singleton),
    CONSTRAINT frameleaf_immich_import_status_check CHECK ((status = ANY (ARRAY['copying'::text, 'verifying'::text, 'activated'::text, 'abandoned'::text])))
);

CREATE TABLE public.frameleaf_immich_import_checkpoint (
    table_name text NOT NULL,
    cursor jsonb,
    row_count bigint DEFAULT 0 NOT NULL,
    complete boolean DEFAULT false NOT NULL
);

CREATE TABLE public.frameleaf_immich_import_work (
    asset_id uuid NOT NULL,
    kind text NOT NULL,
    dispatched_at timestamp with time zone,
    CONSTRAINT frameleaf_immich_import_work_kind_check CHECK ((kind = ANY (ARRAY['metadata'::text, 'thumbnail'::text, 'smart-search'::text, 'face-detection'::text])))
);

CREATE TABLE public.frameleaf_rate_limit (
    key text NOT NULL,
    count integer NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT frameleaf_rate_limit_count_check CHECK ((count >= 0))
);

CREATE TABLE public.frameleaf_session (
    "authTime" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    "handoffCodeHash" text,
    "handoffExpiresAt" timestamp with time zone,
    "sessionId" uuid NOT NULL,
    sid text,
    sub text NOT NULL,
    "userId" uuid NOT NULL
);

CREATE TABLE public.frameleaf_sign_in_revocation (
    "expiresAt" timestamp with time zone NOT NULL,
    kind text NOT NULL,
    "revokedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    value text NOT NULL,
    CONSTRAINT frameleaf_sign_in_revocation_kind_check CHECK ((kind = ANY (ARRAY['sid'::text, 'sub'::text])))
);

CREATE TABLE public.frameleaf_upload_lease (
    key text NOT NULL,
    token text NOT NULL,
    expires_at timestamp with time zone NOT NULL
);

CREATE TABLE public.frameleaf_user_license (
    "activatedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    "activationId" text,
    binding text NOT NULL,
    certificate text NOT NULL,
    "keyHint" text NOT NULL,
    "keySha256" text NOT NULL,
    kind text DEFAULT 'individual'::text NOT NULL,
    "userId" uuid NOT NULL,
    CONSTRAINT frameleaf_user_license_key_hint_check CHECK ((length("keyHint") = 4)),
    CONSTRAINT frameleaf_user_license_kind_check CHECK ((kind = 'individual'::text))
);

CREATE TABLE public.frameleaf_websocket_worker (
    id uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL
);

CREATE TABLE public.geodata_places (
    id integer NOT NULL,
    name character varying(200) NOT NULL,
    longitude double precision NOT NULL,
    latitude double precision NOT NULL,
    "countryCode" character(2) NOT NULL,
    "admin1Code" character varying(20),
    "admin2Code" character varying(80),
    "modificationDate" date NOT NULL,
    "admin1Name" character varying,
    "admin2Name" character varying,
    "alternateNames" character varying
);

CREATE TABLE public.icloud_album (
    "albumId" uuid,
    "connectionId" uuid NOT NULL,
    deleted boolean DEFAULT false NOT NULL,
    "libraryKey" text NOT NULL,
    name text NOT NULL,
    "parentSourceId" text,
    source jsonb DEFAULT '{}'::jsonb NOT NULL,
    "sourceId" text NOT NULL,
    CONSTRAINT icloud_album_source_check CHECK ((jsonb_typeof(source) = 'object'::text))
);

CREATE TABLE public.icloud_checkpoint (
    complete boolean DEFAULT false NOT NULL,
    "connectionId" uuid NOT NULL,
    cursor jsonb,
    scope text NOT NULL,
    "snapshotId" uuid NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.icloud_claim (
    "cplAssetRecordName" text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    holder text NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "ownerId" uuid NOT NULL,
    CONSTRAINT icloud_claim_holder_check CHECK ((holder ~ '^(icloud-sync|device):.+$'::text))
);

CREATE TABLE public.icloud_connection (
    "accountHint" text,
    "authAttempts" integer DEFAULT 0 NOT NULL,
    "authRetryAt" timestamp with time zone,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "encryptedSession" text,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    label text NOT NULL,
    "lastError" text,
    "nextRunAt" timestamp with time zone,
    "ownerId" uuid NOT NULL,
    state text DEFAULT 'paused'::text NOT NULL,
    "unhealthySince" timestamp with time zone,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "icloud_connection_authAttempts_check" CHECK (("authAttempts" >= 0)),
    CONSTRAINT icloud_connection_config_check CHECK ((jsonb_typeof(config) = 'object'::text)),
    CONSTRAINT icloud_connection_label_check CHECK (((length(label) >= 1) AND (length(label) <= 256)))
);

CREATE TABLE public.icloud_identity_audit (
    "batchOrdinal" integer,
    "cohortId" uuid,
    "connectionId" uuid NOT NULL,
    "createdAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    "expectedSha256" bytea NOT NULL,
    "grantGeneration" integer,
    "grantId" uuid,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "identityId" uuid NOT NULL,
    "itemClaimId" uuid,
    "lastError" text,
    "memberOrdinal" bigint,
    "operationId" uuid,
    "originalAssetId" uuid NOT NULL,
    "ownerId" uuid NOT NULL,
    purpose text DEFAULT 'manual-session'::text NOT NULL,
    result text DEFAULT 'queued'::text NOT NULL,
    "resultAssetId" uuid,
    "sessionId" uuid,
    snapshot jsonb NOT NULL,
    "sourceResourceId" uuid NOT NULL,
    "verifiedAt" timestamp with time zone,
    CONSTRAINT icloud_audit_purpose CHECK ((((purpose = 'manual-session'::text) AND ("sessionId" IS NOT NULL) AND ("grantId" IS NULL) AND ("grantGeneration" IS NULL) AND ("cohortId" IS NULL) AND ("memberOrdinal" IS NULL) AND ("batchOrdinal" IS NULL)) OR ((purpose = 'scheduled-weekly'::text) AND ("sessionId" IS NULL) AND ("grantId" IS NOT NULL) AND ("grantGeneration" IS NOT NULL) AND ("grantGeneration" > 0) AND ("cohortId" IS NOT NULL) AND ("memberOrdinal" IS NOT NULL) AND ("memberOrdinal" >= 0) AND ("batchOrdinal" IS NOT NULL) AND ("batchOrdinal" >= 0)))),
    CONSTRAINT "icloud_identity_audit_expectedSha256_check" CHECK ((octet_length("expectedSha256") = 32)),
    CONSTRAINT icloud_identity_audit_result_check CHECK ((result = ANY (ARRAY['queued'::text, 'running'::text, 'match'::text, 'mismatch'::text, 'stale'::text, 'cancelled'::text, 'failed'::text]))),
    CONSTRAINT icloud_identity_audit_snapshot_check CHECK ((jsonb_typeof(snapshot) = 'object'::text))
);

CREATE TABLE public.icloud_identity_reuse (
    "appleFingerprint" text NOT NULL,
    "assetId" uuid NOT NULL,
    basis text NOT NULL,
    "connectionId" uuid NOT NULL,
    "cplAssetRecordName" text NOT NULL,
    "cplMasterRecordName" text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    "editVersion" text DEFAULT ''::text NOT NULL,
    "expectedSha256" bytea NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "identityId" uuid NOT NULL,
    "itemClaimId" uuid NOT NULL,
    "libraryKey" text NOT NULL,
    "operationId" uuid NOT NULL,
    "ownerId" uuid NOT NULL,
    role text NOT NULL,
    snapshot jsonb NOT NULL,
    "sourceResourceId" uuid NOT NULL,
    CONSTRAINT "icloud_identity_reuse_appleFingerprint_check" CHECK ((("appleFingerprint" ~ '^[A-Za-z0-9+/]{28}$'::text) AND (get_byte(decode("appleFingerprint", 'base64'::text), 0) = 1))),
    CONSTRAINT icloud_identity_reuse_basis_check CHECK ((basis = 'exact-identity'::text)),
    CONSTRAINT "icloud_identity_reuse_editVersion_check" CHECK (("editVersion" = ''::text)),
    CONSTRAINT "icloud_identity_reuse_expectedSha256_check" CHECK ((octet_length("expectedSha256") = 32)),
    CONSTRAINT icloud_identity_reuse_role_check CHECK ((role = ANY (ARRAY['original'::text, 'live-motion'::text, 'raw-alternate'::text]))),
    CONSTRAINT icloud_identity_reuse_snapshot_check CHECK (((jsonb_typeof(snapshot) = 'object'::text) AND (snapshot ?& ARRAY['config'::text, 'resourceKey'::text, 'fingerprint'::text, 'sourceRevision'::text, 'masterRevision'::text, 'originalPath'::text, 'updateId'::text, 'checksum'::text, 'algorithm'::text, 'physicalId'::text, 'fileIdentity'::text, 'sourceChecksum'::text]) AND (jsonb_typeof((snapshot -> 'fileIdentity'::text)) = 'object'::text) AND ((snapshot -> 'fileIdentity'::text) ?& ARRAY['dev'::text, 'ino'::text, 'size'::text, 'mtimeMs'::text, 'ctimeMs'::text]) AND (jsonb_typeof(((snapshot -> 'fileIdentity'::text) -> 'dev'::text)) = 'number'::text) AND (jsonb_typeof(((snapshot -> 'fileIdentity'::text) -> 'ino'::text)) = 'number'::text) AND (jsonb_typeof(((snapshot -> 'fileIdentity'::text) -> 'size'::text)) = 'number'::text) AND (jsonb_typeof(((snapshot -> 'fileIdentity'::text) -> 'mtimeMs'::text)) = 'number'::text) AND (jsonb_typeof(((snapshot -> 'fileIdentity'::text) -> 'ctimeMs'::text)) = 'number'::text)))
);

CREATE TABLE public.icloud_membership (
    "addedBySync" boolean DEFAULT false NOT NULL,
    "albumId" uuid,
    "assetId" uuid,
    "connectionId" uuid NOT NULL,
    "libraryKey" text NOT NULL,
    "snapshotId" uuid NOT NULL,
    "sourceAlbumId" text NOT NULL,
    "sourceAssetId" text NOT NULL,
    "sourcePresent" boolean DEFAULT true NOT NULL
);

CREATE TABLE public.icloud_record (
    "connectionId" uuid NOT NULL,
    deleted boolean DEFAULT false NOT NULL,
    fields jsonb NOT NULL,
    "libraryKey" text NOT NULL,
    "masterId" text,
    "recordId" text NOT NULL,
    "recordType" text NOT NULL,
    revision text,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT icloud_record_fields_check CHECK ((jsonb_typeof(fields) = 'object'::text))
);

CREATE TABLE public.icloud_resource (
    "assetId" uuid,
    attempts integer DEFAULT 0 NOT NULL,
    "auditRequestId" uuid,
    "connectionId" uuid NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "expectedSize" bigint NOT NULL,
    "expectedTarget" jsonb,
    fingerprint text NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "lastError" text,
    "leaseExpiresAt" timestamp with time zone,
    "leaseToken" uuid,
    library jsonb NOT NULL,
    "libraryKey" text NOT NULL,
    "nextAttemptAt" timestamp with time zone,
    "ownerId" uuid NOT NULL,
    path text,
    "pendingJobs" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "promotedPath" text,
    "recordId" text NOT NULL,
    "reservedBytes" bigint DEFAULT 0 NOT NULL,
    "resourceKey" text NOT NULL,
    role text NOT NULL,
    sha1 bytea,
    sha256 bytea,
    source jsonb NOT NULL,
    "sourceAssetId" text NOT NULL,
    "stagingPath" text,
    status text DEFAULT 'pending'::text NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    verification jsonb,
    CONSTRAINT icloud_resource_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT icloud_resource_check CHECK ((("leaseToken" IS NULL) = ("leaseExpiresAt" IS NULL))),
    CONSTRAINT "icloud_resource_expectedSize_check" CHECK ((("expectedSize" >= 0) AND ("expectedSize" <= '9007199254740991'::bigint))),
    CONSTRAINT icloud_resource_library_check CHECK ((jsonb_typeof(library) = 'object'::text)),
    CONSTRAINT "icloud_resource_pendingJobs_check" CHECK ((jsonb_typeof("pendingJobs") = 'array'::text)),
    CONSTRAINT "icloud_resource_reservedBytes_check" CHECK ((("reservedBytes" >= 0) AND ("reservedBytes" <= '9007199254740991'::bigint))),
    CONSTRAINT icloud_resource_sha1_check CHECK ((octet_length(sha1) = 20)),
    CONSTRAINT icloud_resource_sha256_check CHECK ((octet_length(sha256) = 32)),
    CONSTRAINT icloud_resource_source_check CHECK ((jsonb_typeof(source) = 'object'::text))
);

CREATE TABLE public.icloud_run (
    "connectionId" uuid NOT NULL,
    counts jsonb DEFAULT '{}'::jsonb NOT NULL,
    "finishedAt" timestamp with time zone,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "ownerId" uuid NOT NULL,
    "startedAt" timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    CONSTRAINT icloud_run_counts_check CHECK ((jsonb_typeof(counts) = 'object'::text))
);

CREATE TABLE public.icloud_source_identity (
    "appleFingerprint" text,
    "assetId" uuid NOT NULL,
    "cloudChecksum" text,
    "cloudIdentifier" text,
    "cplAssetRecordName" text NOT NULL,
    "cplMasterRecordName" text,
    "deliveredAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    "deliveredBy" text NOT NULL,
    "editVersion" text DEFAULT ''::text NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "lastAuditResult" text,
    "lastVerifiedAt" timestamp with time zone,
    library jsonb,
    "libraryKey" text,
    "matchStrength" text,
    "ownerId" uuid NOT NULL,
    role text NOT NULL,
    sha256 bytea NOT NULL,
    CONSTRAINT icloud_source_identity_audit_check CHECK (("lastAuditResult" = ANY (ARRAY['match'::text, 'mismatch'::text]))),
    CONSTRAINT icloud_source_identity_delivered_check CHECK (("deliveredBy" ~ '^(icloud-sync|device):.+$'::text)),
    CONSTRAINT icloud_source_identity_edit_check CHECK (((role = 'edit-render'::text) = ("editVersion" <> ''::text))),
    CONSTRAINT icloud_source_identity_role_check CHECK ((role = ANY (ARRAY['original'::text, 'live-motion'::text, 'raw-alternate'::text, 'edit-render'::text]))),
    CONSTRAINT icloud_source_identity_sha256_check CHECK ((octet_length(sha256) = 32)),
    CONSTRAINT icloud_source_identity_strength_check CHECK (("matchStrength" = ANY (ARRAY['exact'::text, 'corroborated'::text, 'hint'::text])))
);

CREATE TABLE public.icloud_weekly_cohort (
    "cancelledCount" bigint DEFAULT 0 NOT NULL,
    "configFingerprint" text NOT NULL,
    "connectionId" uuid NOT NULL,
    "createdAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    "grantGeneration" integer,
    "grantId" uuid,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "manifestDigest" bytea NOT NULL,
    "matchCount" bigint DEFAULT 0 NOT NULL,
    "mismatchCount" bigint DEFAULT 0 NOT NULL,
    "nextBatch" integer DEFAULT 0 NOT NULL,
    "ownerId" uuid NOT NULL,
    "performedCount" bigint DEFAULT 0 NOT NULL,
    "populationCount" bigint NOT NULL,
    "privacyFingerprint" text NOT NULL,
    seed bytea NOT NULL,
    "selectedCount" bigint NOT NULL,
    "staleCount" bigint NOT NULL,
    status text DEFAULT 'frozen'::text NOT NULL,
    "unavailableCount" bigint DEFAULT 0 NOT NULL,
    "weekStart" date NOT NULL,
    CONSTRAINT icloud_weekly_cohort_check CHECK ((("selectedCount" >= 0) AND ("selectedCount" = (("populationCount" + 99) / 100)))),
    CONSTRAINT icloud_weekly_cohort_check1 CHECK ((("grantId" IS NULL) = ("grantGeneration" IS NULL))),
    CONSTRAINT icloud_weekly_cohort_check2 CHECK ((("matchCount" >= 0) AND ("mismatchCount" >= 0) AND ("unavailableCount" >= 0) AND ("cancelledCount" >= 0) AND ("performedCount" = ("matchCount" + "mismatchCount")) AND ((("performedCount" + "unavailableCount") + "cancelledCount") <= "selectedCount"))),
    CONSTRAINT icloud_weekly_cohort_check3 CHECK (((status <> 'settled'::text) OR ((("performedCount" + "unavailableCount") + "cancelledCount") = "selectedCount"))),
    CONSTRAINT "icloud_weekly_cohort_grantGeneration_check" CHECK ((("grantGeneration" IS NULL) OR ("grantGeneration" > 0))),
    CONSTRAINT "icloud_weekly_cohort_manifestDigest_check" CHECK ((octet_length("manifestDigest") = 32)),
    CONSTRAINT "icloud_weekly_cohort_nextBatch_check" CHECK (("nextBatch" >= 0)),
    CONSTRAINT "icloud_weekly_cohort_populationCount_check" CHECK (("populationCount" >= 0)),
    CONSTRAINT icloud_weekly_cohort_seed_check CHECK ((octet_length(seed) = 32)),
    CONSTRAINT "icloud_weekly_cohort_staleCount_check" CHECK (("staleCount" >= 0)),
    CONSTRAINT icloud_weekly_cohort_status_check CHECK ((status = ANY (ARRAY['frozen'::text, 'running'::text, 'settled'::text]))),
    CONSTRAINT "icloud_weekly_cohort_weekStart_check" CHECK ((EXTRACT(isodow FROM "weekStart") = (1)::numeric))
);

CREATE TABLE public.icloud_weekly_grant (
    "configFingerprint" text NOT NULL,
    "connectionId" uuid NOT NULL,
    "createdAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    generation integer NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "includeProtected" boolean DEFAULT false NOT NULL,
    "inputFingerprint" text NOT NULL,
    "ownerId" uuid NOT NULL,
    "pinBinding" text,
    "privacyFingerprint" text NOT NULL,
    "requestHistory" jsonb NOT NULL,
    "requestKey" uuid NOT NULL,
    "revokedAt" timestamp with time zone,
    CONSTRAINT icloud_weekly_grant_check CHECK (((NOT "includeProtected") OR (enabled AND ("pinBinding" IS NOT NULL)))),
    CONSTRAINT icloud_weekly_grant_check1 CHECK ((enabled OR ("revokedAt" IS NOT NULL))),
    CONSTRAINT icloud_weekly_grant_generation_check CHECK ((generation > 0)),
    CONSTRAINT "icloud_weekly_grant_requestHistory_check" CHECK ((jsonb_typeof("requestHistory") = 'object'::text))
);

CREATE TABLE public.icloud_weekly_member (
    "auditRequestId" uuid,
    "batchOrdinal" integer,
    bindings jsonb NOT NULL,
    "cohortId" uuid NOT NULL,
    "connectionId" uuid NOT NULL,
    "expectedSha256" bytea NOT NULL,
    "grantGeneration" integer,
    "grantId" uuid,
    ordinal bigint NOT NULL,
    outcome text DEFAULT 'pending'::text NOT NULL,
    "ownerId" uuid NOT NULL,
    rank bytea NOT NULL,
    "receiptId" uuid NOT NULL,
    "resourceRoleKey" text NOT NULL,
    selected boolean NOT NULL,
    "technicalEligibility" text NOT NULL,
    CONSTRAINT icloud_weekly_member_bindings_check CHECK (((jsonb_typeof(bindings) = 'object'::text) AND (bindings ?& ARRAY['receipt'::text, 'source'::text, 'identity'::text, 'original'::text]))),
    CONSTRAINT icloud_weekly_member_check CHECK ((("grantId" IS NULL) = ("grantGeneration" IS NULL))),
    CONSTRAINT icloud_weekly_member_check1 CHECK (((selected AND ("technicalEligibility" = 'current'::text) AND ("batchOrdinal" IS NOT NULL) AND ("batchOrdinal" >= 0)) OR ((NOT selected) AND ("batchOrdinal" IS NULL) AND ("auditRequestId" IS NULL)))),
    CONSTRAINT icloud_weekly_member_check2 CHECK ((("auditRequestId" IS NULL) OR (selected AND ("grantId" IS NOT NULL)))),
    CONSTRAINT "icloud_weekly_member_expectedSha256_check" CHECK ((octet_length("expectedSha256") = 32)),
    CONSTRAINT "icloud_weekly_member_grantGeneration_check" CHECK ((("grantGeneration" IS NULL) OR ("grantGeneration" > 0))),
    CONSTRAINT icloud_weekly_member_ordinal_check CHECK ((ordinal >= 0)),
    CONSTRAINT icloud_weekly_member_outcome_check CHECK ((outcome = ANY (ARRAY['pending'::text, 'match'::text, 'mismatch'::text, 'unavailable'::text, 'cancelled'::text]))),
    CONSTRAINT icloud_weekly_member_rank_check CHECK ((octet_length(rank) = 32)),
    CONSTRAINT "icloud_weekly_member_technicalEligibility_check" CHECK (("technicalEligibility" = ANY (ARRAY['current'::text, 'stale'::text])))
);

CREATE TABLE public.integrity_report (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    type character varying NOT NULL,
    path character varying NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "assetId" uuid,
    "fileAssetId" uuid
);

CREATE TABLE public.job (
    id uuid NOT NULL,
    queue text NOT NULL,
    name text NOT NULL,
    data jsonb NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    "dedupKey" text,
    "externalId" text,
    "latestPending" jsonb,
    "safeToRetry" boolean NOT NULL,
    sensitive boolean DEFAULT false NOT NULL,
    "deadlineMs" integer NOT NULL,
    attempt integer DEFAULT 0 NOT NULL,
    "retryBaseAttempt" integer DEFAULT 0 NOT NULL,
    "runId" uuid,
    "itemKey" text,
    "rootItemKey" text,
    "parentId" uuid,
    token uuid,
    "workerId" uuid,
    "availableAt" timestamp with time zone DEFAULT now() NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "startedAt" timestamp with time zone,
    "finishedAt" timestamp with time zone,
    "leaseExpiresAt" timestamp with time zone,
    "progressAt" timestamp with time zone,
    "progressUnits" bigint DEFAULT 0 NOT NULL,
    "cancelRequestedAt" timestamp with time zone,
    "dependencyReason" text,
    error text,
    CONSTRAINT job_check CHECK (((state = 'active'::text) = (token IS NOT NULL))),
    CONSTRAINT job_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'waiting'::text, 'active'::text, 'completed'::text, 'failed'::text, 'needs_attention'::text, 'cancelled'::text, 'blocked'::text])))
)
WITH (autovacuum_vacuum_scale_factor='0.02', autovacuum_analyze_scale_factor='0.05', autovacuum_vacuum_threshold='50', autovacuum_analyze_threshold='50');

CREATE TABLE public.job_attempt (
    "jobId" uuid NOT NULL,
    attempt integer NOT NULL,
    token uuid NOT NULL,
    "workerId" uuid NOT NULL,
    "startedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "finishedAt" timestamp with time zone,
    outcome text,
    error text
)
WITH (autovacuum_vacuum_scale_factor='0.02', autovacuum_analyze_scale_factor='0.05', autovacuum_vacuum_threshold='50', autovacuum_analyze_threshold='50');

CREATE TABLE public.job_queue (
    name text NOT NULL,
    paused boolean DEFAULT false NOT NULL,
    "manifestFilling" boolean DEFAULT false NOT NULL,
    concurrency integer DEFAULT 1 NOT NULL,
    CONSTRAINT job_queue_concurrency_check CHECK ((concurrency > 0))
);

CREATE TABLE public.job_run (
    id uuid NOT NULL,
    kind text NOT NULL,
    selection jsonb NOT NULL,
    "enumerationDone" boolean DEFAULT false NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "finishedAt" timestamp with time zone
);

CREATE TABLE public.job_run_item (
    "runId" uuid NOT NULL,
    "itemKey" text NOT NULL,
    "rootItemKey" text,
    stage text NOT NULL,
    queue text NOT NULL,
    selection jsonb NOT NULL,
    "selectionId" uuid,
    "jobId" uuid,
    state text DEFAULT 'pending'::text NOT NULL,
    CONSTRAINT job_run_item_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'waiting'::text, 'active'::text, 'completed'::text, 'failed'::text, 'needs_attention'::text, 'cancelled'::text, 'blocked'::text])))
)
WITH (autovacuum_vacuum_scale_factor='0.02', autovacuum_analyze_scale_factor='0.05', autovacuum_vacuum_threshold='50', autovacuum_analyze_threshold='50');

CREATE TABLE public.job_selection (
    id uuid NOT NULL,
    "runId" uuid NOT NULL,
    "producerId" uuid,
    stage text NOT NULL,
    queue text NOT NULL,
    "safeToRetry" boolean NOT NULL,
    sensitive boolean NOT NULL,
    "deadlineMs" integer NOT NULL,
    state text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT job_selection_state_check CHECK ((state = ANY (ARRAY['enumerating'::text, 'ready'::text, 'needs_attention'::text])))
);

CREATE TABLE public.job_worker (
    id uuid NOT NULL,
    "startedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "heartbeatAt" timestamp with time zone DEFAULT now() NOT NULL,
    state text DEFAULT 'running'::text NOT NULL,
    CONSTRAINT job_worker_state_check CHECK ((state = ANY (ARRAY['running'::text, 'stopping'::text, 'lost'::text])))
)
WITH (autovacuum_vacuum_scale_factor='0.02', autovacuum_analyze_scale_factor='0.05', autovacuum_vacuum_threshold='50', autovacuum_analyze_threshold='50');

CREATE TABLE public.library (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name character varying NOT NULL,
    "ownerId" uuid NOT NULL,
    "importPaths" text[] NOT NULL,
    "exclusionPatterns" text[] NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp with time zone,
    "refreshedAt" timestamp with time zone,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL
);

CREATE TABLE public.media_operation (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "ownerId" uuid NOT NULL,
    kind character varying NOT NULL,
    status character varying DEFAULT 'queued'::character varying NOT NULL,
    destination character varying NOT NULL,
    "destinationDetail" character varying,
    label character varying NOT NULL,
    "assetId" uuid,
    "resultAssetId" uuid,
    "retryOfId" uuid,
    "projectId" character varying,
    "revisionId" character varying,
    snapshot jsonb NOT NULL,
    settings jsonb NOT NULL,
    estimate jsonb,
    result jsonb,
    progress double precision DEFAULT 0 NOT NULL,
    "processedUnits" bigint DEFAULT 0 NOT NULL,
    "totalUnits" bigint,
    attempt integer DEFAULT 0 NOT NULL,
    "maxAttempts" integer DEFAULT 3 NOT NULL,
    "autoRetries" integer DEFAULT 0 NOT NULL,
    "retryAt" timestamp with time zone,
    "claimToken" uuid,
    "claimedBy" character varying,
    "claimExpiresAt" timestamp with time zone,
    "heartbeatAt" timestamp with time zone,
    "lastAdmissionRefusalReason" character varying,
    "lastAdmissionRefusedAt" timestamp with time zone,
    "admissionRefusals" integer DEFAULT 0 NOT NULL,
    "outputBytes" bigint DEFAULT 0 NOT NULL,
    "attemptStartedAt" timestamp with time zone,
    "cancelRequestedAt" timestamp with time zone,
    "pauseRequestedAt" timestamp with time zone,
    "cancelAcknowledgedAt" timestamp with time zone,
    "remoteJobId" character varying,
    "remoteReleasedAt" timestamp with time zone,
    error text,
    "errorCode" character varying,
    "startedAt" timestamp with time zone,
    "finishedAt" timestamp with time zone,
    "dismissedAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL
);

CREATE TABLE public.media_operation_checkpoint (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "operationId" uuid NOT NULL,
    sequence integer NOT NULL,
    state character varying DEFAULT 'pending'::character varying NOT NULL,
    "chunkKey" character varying NOT NULL,
    "inputDigest" character varying NOT NULL,
    "historyDigest" character varying NOT NULL,
    "configDigest" character varying NOT NULL,
    seed character varying,
    timebase character varying NOT NULL,
    "startTicks" bigint NOT NULL,
    "endTicks" bigint NOT NULL,
    "prerollTicks" bigint DEFAULT 0 NOT NULL,
    "requiresSequentialContext" boolean DEFAULT false NOT NULL,
    "outputPath" character varying,
    "outputChecksum" bytea,
    "sizeInBytes" bigint,
    attempt integer DEFAULT 0 NOT NULL,
    "claimToken" uuid,
    "completedAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL
);

CREATE TABLE public.memory (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp with time zone,
    "ownerId" uuid NOT NULL,
    type character varying NOT NULL,
    data jsonb NOT NULL,
    "isSaved" boolean DEFAULT false NOT NULL,
    "memoryAt" timestamp with time zone NOT NULL,
    "seenAt" timestamp with time zone,
    "showAt" timestamp with time zone,
    "hideAt" timestamp with time zone,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL
);

CREATE TABLE public.memory_asset (
    "memoriesId" uuid NOT NULL,
    "assetId" uuid NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL
);

CREATE TABLE public.memory_asset_audit (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "memoryId" uuid NOT NULL,
    "assetId" uuid NOT NULL,
    "deletedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE public.memory_audit (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "memoryId" uuid NOT NULL,
    "userId" uuid NOT NULL,
    "deletedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE public.memory_curation (
    "assetOrder" uuid[],
    "hiddenAt" timestamp with time zone,
    "memoryId" uuid NOT NULL,
    "ownerId" uuid NOT NULL,
    title text,
    "updatedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT memory_curation_title_check CHECK (((title IS NULL) OR ((char_length(title) >= 1) AND (char_length(title) <= 200))))
);

CREATE TABLE public.memory_export (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "ownerId" uuid NOT NULL,
    "memoryId" uuid NOT NULL,
    format character varying DEFAULT 'archive'::character varying NOT NULL,
    status character varying DEFAULT 'pending'::character varying NOT NULL,
    title character varying NOT NULL,
    "assetIds" jsonb NOT NULL,
    "assetCount" integer DEFAULT 0 NOT NULL,
    "processedAssets" integer DEFAULT 0 NOT NULL,
    path text,
    "sizeInBytes" bigint,
    error text,
    "cancelRequestedAt" timestamp with time zone,
    "startedAt" timestamp with time zone,
    "finishedAt" timestamp with time zone,
    "expiresAt" timestamp with time zone,
    settings jsonb,
    "studioProjectId" uuid,
    "studioExportVersionId" uuid,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.memory_show_less (
    "createdAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    kind text NOT NULL,
    "userId" uuid NOT NULL,
    value text NOT NULL,
    CONSTRAINT memory_show_less_kind_check CHECK ((kind = ANY (ARRAY['person'::text, 'pet'::text, 'date'::text, 'type'::text]))),
    CONSTRAINT memory_show_less_value_check CHECK (((char_length(value) >= 1) AND (char_length(value) <= 64)))
);

CREATE TABLE public.ml_cloud_model_choice (
    "modelGroup" text NOT NULL,
    "modelId" text NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.ml_destination (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    url text,
    "authToken" text,
    enabled boolean DEFAULT true NOT NULL,
    workloads jsonb DEFAULT '[]'::jsonb NOT NULL,
    "consentAcknowledgedAt" timestamp with time zone,
    "consentAcknowledgedBy" uuid,
    "budgetLimitUsd" double precision,
    "maxRuntimeMinutes" integer,
    "maxUploadBytes" bigint,
    "lastProbeAt" timestamp with time zone,
    "lastProbeHealth" text DEFAULT 'unknown'::text NOT NULL,
    "lastProbeSummary" text,
    "lastProbeWorkloads" jsonb,
    "lastProbeHardware" jsonb,
    "lastProbeLatencyMs" integer,
    "sharesLibraryHardware" boolean DEFAULT false NOT NULL,
    region text,
    "consentVersion" text,
    "lastProbeCloud" jsonb,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ml_destination_kind_check CHECK ((kind = ANY (ARRAY['local'::text, 'lan'::text, 'frameleaf-cloud'::text])))
);

CREATE TABLE public.ml_workload_accounting (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "destinationId" uuid,
    "destinationKind" text NOT NULL,
    workload text NOT NULL,
    "jobId" text,
    "jobName" text,
    "bytesSent" bigint DEFAULT 0 NOT NULL,
    "bytesReceived" bigint DEFAULT 0 NOT NULL,
    "durationMs" integer DEFAULT 0 NOT NULL,
    outcome text NOT NULL,
    "costUsd" double precision,
    credits double precision,
    "cloudJobId" text,
    "startedAt" timestamp with time zone NOT NULL,
    "finishedAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.ml_workload_route (
    workload text NOT NULL,
    "destinationId" uuid NOT NULL,
    "modelId" text,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.move_history (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "entityId" uuid NOT NULL,
    "pathType" character varying NOT NULL,
    "oldPath" character varying NOT NULL,
    "newPath" character varying NOT NULL
);

CREATE TABLE public.naturalearth_countries (
    id integer NOT NULL,
    admin character varying(50) NOT NULL,
    admin_a3 character varying(3) NOT NULL,
    type character varying(50) NOT NULL,
    coordinates polygon NOT NULL
);

ALTER TABLE public.naturalearth_countries ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.naturalearth_countries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.notification (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp with time zone,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "userId" uuid,
    level character varying DEFAULT 'info'::character varying NOT NULL,
    type character varying DEFAULT 'info'::character varying NOT NULL,
    data jsonb,
    title character varying NOT NULL,
    description text,
    "readAt" timestamp with time zone
);

CREATE TABLE public.ocr_search (
    "assetId" uuid NOT NULL,
    text text NOT NULL
);

CREATE TABLE public.operational_metric_sample (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    series character varying NOT NULL,
    "scopeKey" character varying NOT NULL,
    "userId" uuid,
    "libraryId" uuid,
    grain character varying NOT NULL,
    "bucketStart" timestamp with time zone NOT NULL,
    value bigint NOT NULL,
    "observedAt" timestamp with time zone NOT NULL
);

CREATE TABLE public.partner (
    "sharedById" uuid NOT NULL,
    "sharedWithId" uuid NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "createId" uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "inTimeline" boolean DEFAULT false NOT NULL,
    "shareLocation" boolean DEFAULT false NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL
);

CREATE TABLE public.partner_audit (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "sharedById" uuid NOT NULL,
    "sharedWithId" uuid NOT NULL,
    "deletedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE public.partner_backfill (
    cursor uuid,
    done integer DEFAULT 0 NOT NULL,
    "sharedById" uuid NOT NULL,
    "sharedWithId" uuid NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    total integer DEFAULT 0 NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE public.partner_person_link (
    "correctionId" uuid,
    "createdAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    kind text NOT NULL,
    "ownerId" uuid NOT NULL,
    "partnerSharedById" uuid NOT NULL,
    "personGroupId" uuid NOT NULL,
    "sourcePersonGroupId" uuid NOT NULL,
    CONSTRAINT partner_person_link_kind_check CHECK ((kind = ANY (ARRAY['created'::text, 'merged'::text])))
);

CREATE TABLE public.person (
    "ownerId" uuid NOT NULL,
    "personGroupId" uuid NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    name character varying DEFAULT ''::character varying NOT NULL,
    "thumbnailPath" character varying DEFAULT ''::character varying NOT NULL,
    "isHidden" boolean DEFAULT false NOT NULL,
    "birthDate" date,
    "faceAssetId" uuid,
    "isFavorite" boolean DEFAULT false NOT NULL,
    color character varying,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    CONSTRAINT "person_birthDate_chk" CHECK (("birthDate" <= CURRENT_DATE))
);

CREATE TABLE public.person_audit (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "personGroupId" uuid NOT NULL,
    "ownerId" uuid NOT NULL,
    "deletedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE public.person_group (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "clusterGroupId" uuid NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "createId" uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL
);

CREATE TABLE public.person_group_audit (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "personGroupId" uuid NOT NULL,
    "clusterGroupId" uuid NOT NULL,
    "deletedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE public.person_merge_verdict (
    "createdAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    "ownerId" uuid NOT NULL,
    "personFaceId" uuid,
    "personId" uuid NOT NULL,
    "suggestionFaceId" uuid,
    "suggestionId" uuid NOT NULL,
    verdict text NOT NULL,
    CONSTRAINT person_merge_verdict_check CHECK (((("personId" < "suggestionId") AND (verdict <> 'ignore'::text)) OR (("personId" = "suggestionId") AND (verdict = 'ignore'::text)))),
    CONSTRAINT person_merge_verdict_verdict_check CHECK ((verdict = ANY (ARRAY['different'::text, 'later'::text, 'ignore'::text])))
);

CREATE TABLE public.person_origin (
    "createdAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    following boolean DEFAULT true NOT NULL,
    "overriddenFields" text[] DEFAULT '{}'::text[] NOT NULL,
    "ownerId" uuid NOT NULL,
    "partnerSharedById" uuid NOT NULL,
    "personGroupId" uuid NOT NULL,
    "rootOwnerId" uuid NOT NULL,
    "sourceOwnerId" uuid NOT NULL,
    "sourcePersonGroupId" uuid NOT NULL
);

CREATE TABLE public.pet (
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "ownerId" uuid NOT NULL,
    name character varying DEFAULT ''::character varying NOT NULL,
    species character varying DEFAULT 'other'::character varying NOT NULL,
    "birthDate" date,
    "featuredAssetId" uuid,
    "isHidden" boolean DEFAULT false NOT NULL,
    "isFavorite" boolean DEFAULT false NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.pet_audit (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "petId" uuid NOT NULL,
    "ownerId" uuid NOT NULL,
    "deletedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE public.pet_candidate (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "detectionId" uuid NOT NULL,
    "petId" uuid NOT NULL,
    score double precision DEFAULT 0 NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.pet_detection (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "assetId" uuid NOT NULL,
    "boundingBoxX1" integer DEFAULT 0 NOT NULL,
    "boundingBoxY1" integer DEFAULT 0 NOT NULL,
    "boundingBoxX2" integer DEFAULT 0 NOT NULL,
    "boundingBoxY2" integer DEFAULT 0 NOT NULL,
    "imageWidth" integer DEFAULT 0 NOT NULL,
    "imageHeight" integer DEFAULT 0 NOT NULL,
    species character varying,
    score double precision DEFAULT 0 NOT NULL,
    "modelName" character varying NOT NULL,
    "modelRevision" character varying NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.pet_observation (
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "petId" uuid NOT NULL,
    "assetId" uuid NOT NULL,
    state character varying DEFAULT 'confirmed'::character varying NOT NULL,
    source character varying DEFAULT 'manual'::character varying NOT NULL,
    "boundingBoxX1" integer,
    "boundingBoxY1" integer,
    "boundingBoxX2" integer,
    "boundingBoxY2" integer,
    "imageWidth" integer,
    "imageHeight" integer,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "sourceChecksum" bytea,
    "staleAt" timestamp with time zone
);

CREATE TABLE public.pet_observation_audit (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "observationId" uuid NOT NULL,
    "petId" uuid NOT NULL,
    "assetId" uuid NOT NULL,
    "ownerId" uuid NOT NULL,
    "deletedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE public.pet_recognition_run (
    "assetCount" integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    "destinationKind" text,
    error text,
    "finishedAt" timestamp with time zone,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "ownerId" uuid NOT NULL,
    "processedCount" integer DEFAULT 0 NOT NULL,
    "proposalCount" integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT pet_recognition_run_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'cancelled'::text, 'failed'::text])))
);

CREATE TABLE public.photography_studio_site (
    "ownerId" uuid NOT NULL,
    revision uuid NOT NULL,
    value jsonb NOT NULL,
    CONSTRAINT photography_site_value_check CHECK ((jsonb_typeof(value) = 'object'::text))
);

CREATE TABLE public.photography_workflow (
    "albumId" uuid NOT NULL,
    "createdAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    id uuid NOT NULL,
    "ownerId" uuid NOT NULL,
    revision uuid NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    value jsonb NOT NULL,
    CONSTRAINT photography_workflow_value_check CHECK (((jsonb_typeof(value) = 'object'::text) AND (octet_length((value)::text) <= 20000000)))
);

CREATE TABLE public.physical_file (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    type character varying NOT NULL,
    checksum bytea NOT NULL,
    "sizeInBytes" bigint NOT NULL,
    path character varying NOT NULL,
    "canonicalAssetId" uuid,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL
);

CREATE TABLE public.physical_file_trash (
    checksum bytea NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "lastAssetId" uuid,
    "lastOwnerId" uuid,
    "originalFileName" text NOT NULL,
    path text NOT NULL,
    "physicalFileId" uuid,
    "sizeInBytes" bigint NOT NULL,
    "trashedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE public.plugin (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    name character varying NOT NULL,
    version character varying NOT NULL,
    title character varying NOT NULL,
    description character varying NOT NULL,
    author character varying NOT NULL,
    "wasmBytes" bytea NOT NULL,
    templates jsonb NOT NULL,
    sha256hash bytea NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.plugin_method (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "pluginId" uuid NOT NULL,
    name character varying NOT NULL,
    title character varying NOT NULL,
    description character varying NOT NULL,
    types character varying[] NOT NULL,
    "hostFunctions" boolean DEFAULT false NOT NULL,
    "allowedHosts" character varying[] DEFAULT '{}'::character varying[] NOT NULL,
    schema jsonb,
    "uiHints" character varying[] DEFAULT '{}'::character varying[] NOT NULL
);

CREATE TABLE public.preservation_item (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "packageId" uuid NOT NULL,
    "sourceAssetId" uuid NOT NULL,
    "assetId" uuid,
    state character varying DEFAULT 'pending'::character varying NOT NULL,
    locked boolean DEFAULT false NOT NULL,
    entry jsonb,
    attempts integer DEFAULT 0 NOT NULL,
    "verifyState" character varying,
    "reasonKey" character varying,
    error text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL
);

CREATE TABLE public.preservation_package (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "ownerId" uuid NOT NULL,
    origin character varying NOT NULL,
    name character varying NOT NULL,
    status character varying DEFAULT 'building'::character varying NOT NULL,
    format character varying NOT NULL,
    path character varying NOT NULL,
    "originalFileName" character varying,
    "sizeBytes" bigint,
    digest character varying,
    "includeLocked" boolean DEFAULT false NOT NULL,
    "includeMetadata" boolean DEFAULT true NOT NULL,
    scope jsonb,
    manifest jsonb,
    verification jsonb,
    "verifiedAt" timestamp with time zone,
    "expiresAt" timestamp with time zone,
    "removedAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL
);

CREATE TABLE public.preservation_restore (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "ownerId" uuid NOT NULL,
    "packageId" uuid,
    name character varying NOT NULL,
    status character varying DEFAULT 'reviewing'::character varying NOT NULL,
    "packageIdentity" character varying,
    options jsonb NOT NULL,
    summary jsonb,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL
);

CREATE TABLE public.preservation_restore_item (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "restoreId" uuid NOT NULL,
    "sourceAssetId" uuid NOT NULL,
    state character varying DEFAULT 'ready'::character varying NOT NULL,
    match character varying,
    "assetId" uuid,
    locked boolean DEFAULT false NOT NULL,
    entry jsonb,
    sidecar jsonb,
    conflicts jsonb,
    decisions jsonb,
    findings jsonb,
    "reasonKey" character varying,
    error text,
    attempts integer DEFAULT 0 NOT NULL,
    "creatingAt" timestamp with time zone,
    "appliedAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL
);

CREATE TABLE public.push_device (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "userId" uuid NOT NULL,
    "sessionId" uuid NOT NULL,
    platform text NOT NULL,
    "pushToken" text NOT NULL,
    "apnsEnvironment" text,
    "pushToStartToken" text,
    "publicKey" text NOT NULL,
    "backupDeviceKey" uuid,
    "disabledEvents" text[] DEFAULT '{}'::text[] NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "lastDeliveredAt" timestamp with time zone,
    "lastStaleWakeAt" timestamp with time zone
);

CREATE TABLE public.push_device_activity (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "deviceId" uuid NOT NULL,
    "activityId" text NOT NULL,
    kind text NOT NULL,
    token text NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.recipient_group (
    "createdAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    "ownerId" uuid NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    "userIds" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    CONSTRAINT recipient_group_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 100))),
    CONSTRAINT recipient_group_size_check CHECK ((cardinality("userIds") <= 200))
);

CREATE TABLE public.render_worker (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    name character varying NOT NULL,
    destination character varying NOT NULL,
    status character varying DEFAULT 'active'::character varying NOT NULL,
    "enrolmentSecret" bytea NOT NULL,
    kinds character varying[] NOT NULL,
    "engineDigest" character varying,
    "conformanceMaxAgeMs" integer DEFAULT 604800000 NOT NULL,
    "lastConformanceReportedAt" timestamp with time zone,
    "maxConcurrentOperations" integer DEFAULT 1 NOT NULL,
    "maxWallClockMs" bigint,
    "maxOutputBytes" bigint,
    "gpuMemoryBytes" bigint,
    "lastAdmittedAt" timestamp with time zone,
    "lastSeenAt" timestamp with time zone,
    "revokedAt" timestamp with time zone,
    "createdBy" uuid,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL
);

CREATE TABLE public.render_worker_audit (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "workerId" uuid,
    event character varying NOT NULL,
    reason character varying,
    "operationId" uuid,
    "actorId" uuid,
    detail jsonb,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.render_worker_limit (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    subject character varying NOT NULL,
    "userId" uuid,
    "maxConcurrentOperations" integer DEFAULT 2 NOT NULL,
    "maxWallClockMs" bigint,
    "maxOutputBytes" bigint,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL
);

CREATE TABLE public.render_worker_session (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "workerId" uuid NOT NULL,
    token bytea NOT NULL,
    scopes character varying[] NOT NULL,
    "gpuMemoryBytes" bigint,
    "engineDigest" character varying,
    "conformanceReportedAt" timestamp with time zone NOT NULL,
    codecs character varying[],
    "colorPrecision" jsonb,
    "expiresAt" timestamp with time zone NOT NULL,
    "revokedAt" timestamp with time zone,
    "lastUsedAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.render_worker_session_capability (
    codecs text[] DEFAULT '{}'::text[] NOT NULL,
    "createdAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    formats text[] DEFAULT '{}'::text[] NOT NULL,
    "sessionId" uuid NOT NULL
);

CREATE TABLE public.session (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    token bytea NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "expiresAt" timestamp with time zone,
    "userId" uuid NOT NULL,
    "parentId" uuid,
    "deviceType" character varying DEFAULT ''::character varying NOT NULL,
    "deviceOS" character varying DEFAULT ''::character varying NOT NULL,
    "appVersion" character varying,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "isPendingSyncReset" boolean DEFAULT false NOT NULL,
    "pinExpiresAt" timestamp with time zone,
    "oauthSid" character varying,
    "oauthBearerToken" character varying
);

CREATE TABLE public.session_sync_checkpoint (
    "sessionId" uuid NOT NULL,
    type character varying NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    ack character varying NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL
);

CREATE TABLE public.session_tag_sync_state (
    "sessionId" uuid NOT NULL,
    kind character varying NOT NULL,
    key character varying NOT NULL,
    "entityId" uuid NOT NULL,
    "assetId" uuid,
    "sourceId" uuid NOT NULL,
    "eventId" uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "deliveryOrder" bigint,
    action text NOT NULL,
    delivered boolean DEFAULT false NOT NULL,
    acknowledged boolean DEFAULT false NOT NULL,
    "potentiallyVisible" boolean DEFAULT false NOT NULL,
    "confirmedVisible" boolean DEFAULT false NOT NULL
);

CREATE TABLE public.shared_link (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    description character varying,
    "userId" uuid NOT NULL,
    key bytea NOT NULL,
    type character varying NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "expiresAt" timestamp with time zone,
    "allowUpload" boolean DEFAULT false NOT NULL,
    "albumId" uuid,
    "allowDownload" boolean DEFAULT true NOT NULL,
    "showExif" boolean DEFAULT true NOT NULL,
    password character varying,
    slug character varying
);

CREATE TABLE public.shared_link_asset (
    "assetId" uuid NOT NULL,
    "sharedLinkId" uuid NOT NULL
);

CREATE TABLE public.shared_space_album (
    "albumId" uuid NOT NULL,
    "linkedAlbumId" uuid NOT NULL,
    "linkedById" uuid,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.shared_space_comment_thread (
    "activityId" uuid NOT NULL,
    "parentActivityId" uuid NOT NULL,
    "albumId" uuid NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.shared_space_event (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "albumId" uuid NOT NULL,
    "actorId" uuid,
    type character varying NOT NULL,
    "targetUserId" uuid,
    "activityId" uuid,
    "assetIds" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    subject character varying,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.shared_space_invite (
    "albumId" uuid NOT NULL,
    "userId" uuid NOT NULL,
    role public.album_user_role_enum DEFAULT 'editor'::public.album_user_role_enum NOT NULL,
    "invitedById" uuid,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.shared_space_mention (
    "activityId" uuid NOT NULL,
    "userId" uuid NOT NULL
);

CREATE TABLE public.shared_space_person (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "albumId" uuid NOT NULL,
    "personOwnerId" uuid NOT NULL,
    "personGroupId" uuid NOT NULL,
    name character varying DEFAULT ''::character varying NOT NULL,
    "coverAssetId" uuid,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.shared_space_visit (
    "albumId" uuid NOT NULL,
    "userId" uuid NOT NULL,
    "lastSeenAt" timestamp with time zone NOT NULL
);

CREATE TABLE public.smart_album (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    kind text NOT NULL,
    "ownerId" uuid NOT NULL,
    "albumId" uuid NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.smart_album_asset (
    "smartAlbumId" uuid NOT NULL,
    "assetId" uuid NOT NULL,
    "addedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "matchReason" text NOT NULL,
    CONSTRAINT "smart_album_asset_matchReason_check" CHECK (("matchReason" = ANY (ARRAY['tag'::text, 'clip'::text, 'both'::text])))
);

CREATE TABLE public.smart_album_exclusion (
    "smartAlbumId" uuid NOT NULL,
    "assetId" uuid NOT NULL
);

CREATE TABLE public.smart_search (
    "assetId" uuid NOT NULL,
    embedding public.vector(768) NOT NULL
);

CREATE TABLE public.smart_search_description (
    "assetId" uuid NOT NULL,
    embedding public.vector(768) NOT NULL
);

CREATE TABLE public.socket_io_attachments (
    id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    payload bytea NOT NULL
);

CREATE SEQUENCE public.socket_io_attachments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.socket_io_attachments_id_seq OWNED BY public.socket_io_attachments.id;

CREATE TABLE public.stack (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "primaryAssetId" uuid NOT NULL,
    "ownerId" uuid NOT NULL
);

CREATE TABLE public.stack_audit (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "stackId" uuid NOT NULL,
    "userId" uuid NOT NULL,
    "deletedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE public.studio_bundle_upload (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "ownerId" uuid NOT NULL,
    path character varying NOT NULL,
    "sizeBytes" bigint NOT NULL,
    digest character varying NOT NULL,
    "originalFileName" character varying NOT NULL,
    manifest jsonb NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "consumedAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.studio_export_remote_reference (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "versionId" uuid,
    "operationId" uuid NOT NULL,
    "ownerId" uuid,
    "workerId" character varying,
    destination character varying NOT NULL,
    "remoteRef" character varying,
    reason character varying NOT NULL,
    "requestedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "acknowledgedAt" timestamp with time zone
);

CREATE TABLE public.studio_export_version (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "ownerId" uuid NOT NULL,
    "projectId" uuid,
    revision integer NOT NULL,
    "revisionDigest" character varying NOT NULL,
    "renderOperationId" uuid,
    "publishOperationId" uuid,
    state character varying DEFAULT 'rendering'::character varying NOT NULL,
    version integer,
    scope character varying,
    destination character varying NOT NULL,
    settings jsonb NOT NULL,
    "workerId" character varying,
    "engineDigest" character varying,
    "outputPath" character varying,
    "outputChecksum" bytea,
    "outputSizeInBytes" bigint,
    "outputContentType" character varying,
    "outputRemoteRef" character varying,
    "outputRemovedAt" timestamp with time zone,
    "resultAssetId" uuid,
    privacy jsonb,
    "errorCode" character varying,
    error text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "publishedAt" timestamp with time zone,
    "cancelledAt" timestamp with time zone
);

CREATE TABLE public.studio_export_version_source (
    "versionId" uuid NOT NULL,
    key character varying NOT NULL,
    kind character varying NOT NULL,
    "resourceId" character varying NOT NULL,
    "assetId" uuid,
    "ownerId" uuid,
    checksum character varying,
    "sourceAccess" character varying NOT NULL,
    locked boolean,
    "lockReason" character varying,
    sensitive boolean
);

CREATE TABLE public.studio_generated_resource (
    checksum text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    "derivedFrom" jsonb NOT NULL,
    id text NOT NULL,
    "ownerId" uuid NOT NULL,
    path text NOT NULL,
    producer text NOT NULL,
    "projectId" uuid NOT NULL,
    "sourceRevision" integer NOT NULL,
    CONSTRAINT studio_generated_resource_lineage_check CHECK ((jsonb_typeof("derivedFrom") = 'array'::text)),
    CONSTRAINT studio_generated_resource_revision_check CHECK (("sourceRevision" > 0))
);

CREATE TABLE public.studio_hdr_intermediate (
    "assetId" uuid NOT NULL,
    "createdAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    "lastUsedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    "ownerId" uuid NOT NULL,
    path text,
    "sourceFingerprint" bytea NOT NULL,
    status text NOT NULL,
    CONSTRAINT studio_hdr_intermediate_path_check CHECK (((status = 'ready'::text) = (path IS NOT NULL))),
    CONSTRAINT studio_hdr_intermediate_status_check CHECK ((status = ANY (ARRAY['ready'::text, 'ineligible'::text, 'failed'::text])))
);

CREATE TABLE public.studio_preview_frame (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "ownerId" uuid NOT NULL,
    "projectId" character varying NOT NULL,
    "revisionDigest" character varying NOT NULL,
    "projectRevision" integer,
    "grantToken" text,
    "grantSessionId" character varying,
    "cacheKey" character varying NOT NULL,
    "timeNumerator" bigint NOT NULL,
    "timeDenominator" bigint NOT NULL,
    quality character varying NOT NULL,
    "viewportWidth" integer NOT NULL,
    "viewportHeight" integer NOT NULL,
    status character varying DEFAULT 'pending'::character varying NOT NULL,
    "operationId" uuid,
    "seekGeneration" bigint DEFAULT 0 NOT NULL,
    "framePath" character varying,
    "contentType" character varying,
    "sizeInBytes" bigint,
    "frameChecksum" bytea,
    "framePts" bigint,
    "framePtsTimebase" character varying,
    "toneMapped" boolean DEFAULT false NOT NULL,
    "errorCode" character varying,
    "requestedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "readyAt" timestamp with time zone,
    "lastAccessedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "expiresAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL
);

CREATE TABLE public.studio_project (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "ownerId" uuid NOT NULL,
    name character varying NOT NULL,
    "spaceId" uuid,
    "currentRevision" integer DEFAULT 0 NOT NULL,
    "leaseHolderId" uuid,
    "leaseClientId" character varying,
    "leaseExpiresAt" timestamp with time zone,
    "deletedAt" timestamp with time zone,
    "purgeAfter" timestamp with time zone,
    "archivedAt" timestamp with time zone,
    "lastOpenedAt" timestamp with time zone,
    "thumbnailAssetId" uuid,
    "duplicatedFromId" uuid,
    "importedFromDigest" character varying,
    "importOperationId" uuid,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL
);

CREATE TABLE public.studio_project_comment (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "projectId" uuid NOT NULL,
    "authorId" uuid NOT NULL,
    revision integer NOT NULL,
    "timeNum" bigint NOT NULL,
    "timeDen" bigint NOT NULL,
    text text NOT NULL,
    "resolvedAt" timestamp with time zone,
    "resolvedById" uuid,
    "requestKey" character varying,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL
);

CREATE TABLE public.studio_project_import (
    checksum text NOT NULL,
    "contentType" text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    "externalReferences" integer,
    "fileName" text NOT NULL,
    id uuid NOT NULL,
    "ownerId" uuid NOT NULL,
    path text NOT NULL,
    "projectId" uuid NOT NULL,
    "sizeBytes" bigint NOT NULL,
    CONSTRAINT studio_project_import_checksum_check CHECK ((checksum ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT studio_project_import_references_check CHECK ((("externalReferences" IS NULL) OR ("externalReferences" >= 0))),
    CONSTRAINT studio_project_import_size_check CHECK (("sizeBytes" > 0))
);

CREATE TABLE public.studio_project_revision (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "projectId" uuid NOT NULL,
    revision integer NOT NULL,
    "authorId" uuid,
    envelope jsonb NOT NULL,
    digest character varying NOT NULL,
    "graphBytes" integer NOT NULL,
    summary jsonb NOT NULL,
    "requestKey" character varying,
    "restoredFromRevision" integer,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.studio_workspace_layout (
    "engineRevision" text NOT NULL,
    layout jsonb NOT NULL,
    "savedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    "userId" uuid NOT NULL,
    CONSTRAINT studio_workspace_layout_object_check CHECK ((jsonb_typeof(layout) = 'object'::text))
);

CREATE TABLE public.system_metadata (
    key character varying NOT NULL,
    value jsonb NOT NULL
);

CREATE TABLE public.tag (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "userId" uuid NOT NULL,
    value character varying NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    color character varying,
    "parentId" uuid,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL
);

CREATE TABLE public.tag_asset (
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "assetId" uuid NOT NULL,
    "tagId" uuid NOT NULL
);

CREATE TABLE public.tag_asset_audit (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "tagId" uuid NOT NULL,
    "assetId" uuid NOT NULL,
    "userId" uuid NOT NULL,
    "deletedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE public.tag_audit (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "tagId" uuid NOT NULL,
    "userId" uuid NOT NULL,
    "deletedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE public.tag_closure (
    id_ancestor uuid NOT NULL,
    id_descendant uuid NOT NULL
);

CREATE TABLE public.takeout_album (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "ownerId" uuid NOT NULL,
    folder character varying NOT NULL,
    "albumId" uuid NOT NULL
);

CREATE TABLE public.takeout_file (
    id uuid NOT NULL,
    "importId" uuid NOT NULL,
    "sourceId" uuid NOT NULL,
    "entryName" character varying NOT NULL,
    "relativePath" character varying NOT NULL,
    folder character varying NOT NULL,
    name character varying NOT NULL,
    kind character varying NOT NULL,
    path character varying NOT NULL,
    size bigint NOT NULL,
    checksum bytea NOT NULL,
    "legacyChecksum" bytea NOT NULL,
    "modifiedAt" timestamp with time zone NOT NULL,
    metadata jsonb
);

CREATE TABLE public.takeout_import (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "ownerId" uuid NOT NULL,
    name character varying NOT NULL,
    phase character varying DEFAULT 'sources'::character varying NOT NULL,
    options jsonb NOT NULL,
    "runOperationId" uuid,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.takeout_item (
    id uuid NOT NULL,
    "importId" uuid NOT NULL,
    state character varying DEFAULT 'ready'::character varying NOT NULL,
    metadata jsonb NOT NULL,
    "sidecarId" uuid,
    candidates jsonb NOT NULL,
    albums jsonb NOT NULL,
    warnings jsonb NOT NULL,
    locked boolean DEFAULT false NOT NULL,
    "assetId" uuid,
    "resultKind" character varying,
    "createPath" character varying,
    error text,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.takeout_pair (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "importId" uuid NOT NULL,
    "photoItemId" uuid NOT NULL,
    "videoItemId" uuid NOT NULL,
    state character varying DEFAULT 'suggested'::character varying NOT NULL,
    reason character varying NOT NULL,
    error text
);

CREATE TABLE public.takeout_source (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "importId" uuid NOT NULL,
    name character varying NOT NULL,
    kind character varying NOT NULL,
    path character varying NOT NULL,
    size bigint DEFAULT 0 NOT NULL,
    received bigint DEFAULT 0 NOT NULL,
    rejected integer DEFAULT 0 NOT NULL,
    scanned boolean DEFAULT false NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public."user" (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    email character varying NOT NULL,
    password character varying,
    "pinCode" character varying,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "profileImagePath" character varying DEFAULT ''::character varying NOT NULL,
    "profileImageAssetId" uuid,
    "isAdmin" boolean DEFAULT false NOT NULL,
    "shouldChangePassword" boolean DEFAULT true NOT NULL,
    "avatarColor" character varying,
    "deletedAt" timestamp with time zone,
    "oauthId" character varying,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "storageLabel" character varying,
    name character varying DEFAULT ''::character varying NOT NULL,
    "quotaSizeInBytes" bigint,
    "quotaUsageInBytes" bigint DEFAULT 0 NOT NULL,
    status character varying DEFAULT 'active'::character varying NOT NULL,
    "profileChangedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "clusterGroupId" uuid NOT NULL
);

CREATE TABLE public.user_audit (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "userId" uuid NOT NULL,
    "deletedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE public.user_metadata (
    "userId" uuid NOT NULL,
    key character varying NOT NULL,
    value jsonb NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.user_metadata_audit (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "userId" uuid NOT NULL,
    key character varying NOT NULL,
    "deletedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE public.user_preference_history (
    changes jsonb NOT NULL,
    "createdAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    "deviceLabel" text,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "omittedChanges" integer DEFAULT 0 NOT NULL,
    "userId" uuid NOT NULL,
    CONSTRAINT user_preference_history_changes_check CHECK ((jsonb_typeof(changes) = 'array'::text)),
    CONSTRAINT user_preference_history_omitted_check CHECK (("omittedChanges" >= 0))
);

CREATE TABLE public.utility_activity (
    action text NOT NULL,
    bytes bigint DEFAULT 0 NOT NULL,
    "createdAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "itemCount" integer NOT NULL,
    items jsonb NOT NULL,
    tool text NOT NULL,
    "userId" uuid NOT NULL,
    CONSTRAINT utility_activity_action_check CHECK ((action = ANY (ARRAY['trash'::text, 'restore'::text]))),
    CONSTRAINT utility_activity_bytes_check CHECK ((bytes >= 0)),
    CONSTRAINT utility_activity_count_check CHECK (("itemCount" >= 0)),
    CONSTRAINT utility_activity_items_check CHECK ((jsonb_typeof(items) = 'array'::text)),
    CONSTRAINT utility_activity_tool_check CHECK ((tool = 'large-files'::text))
);

CREATE TABLE public.version_history (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    version character varying NOT NULL
);

CREATE TABLE public.video_edit_selection (
    "assetId" uuid NOT NULL,
    "currentVersionId" uuid,
    "ownerId" uuid NOT NULL,
    "requestedVersionId" uuid
);

CREATE TABLE public.video_edit_version (
    "assetId" uuid NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    files jsonb DEFAULT '[]'::jsonb NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "masterPath" text,
    "ownerId" uuid NOT NULL,
    "proxyPath" text,
    purpose text NOT NULL,
    recipe jsonb NOT NULL,
    "sourceChecksum" bytea NOT NULL,
    "sourcePath" text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    CONSTRAINT video_edit_version_check CHECK ((("masterPath" IS NULL) = ("proxyPath" IS NULL))),
    CONSTRAINT video_edit_version_check1 CHECK ((("masterPath" IS NULL) OR (("masterPath" <> "sourcePath") AND ("proxyPath" <> "sourcePath") AND ("masterPath" <> "proxyPath")))),
    CONSTRAINT video_edit_version_files_check CHECK ((jsonb_typeof(files) = 'array'::text)),
    CONSTRAINT video_edit_version_purpose_check CHECK ((purpose = ANY (ARRAY['save'::text, 'export'::text, 'revert'::text]))),
    CONSTRAINT video_edit_version_recipe_check CHECK ((jsonb_typeof(recipe) = 'array'::text)),
    CONSTRAINT video_edit_version_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'ready'::text, 'failed'::text])))
);

CREATE TABLE public.video_moment (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "assetId" uuid NOT NULL,
    source character varying NOT NULL,
    "timestampMs" integer NOT NULL,
    "endMs" integer,
    "frameId" uuid,
    caption text,
    transcript text,
    provenance jsonb,
    "createdById" uuid,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL
);

CREATE TABLE public.video_moment_frame (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "assetId" uuid NOT NULL,
    "frameIndex" integer NOT NULL,
    "timestampMs" integer NOT NULL,
    path character varying NOT NULL,
    width integer,
    height integer,
    score double precision NOT NULL,
    rank integer NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL
);

CREATE TABLE public.video_moment_frame_embedding (
    "frameId" uuid NOT NULL,
    embedding public.vector(512) NOT NULL,
    "modelName" character varying NOT NULL
);

CREATE TABLE public.video_moment_index (
    "assetId" uuid NOT NULL,
    "sourceFingerprint" character varying NOT NULL,
    "extractorVersion" character varying NOT NULL,
    "frameCount" integer DEFAULT 0 NOT NULL,
    "framesExtractedAt" timestamp with time zone,
    "embeddingModel" character varying,
    "embeddingDestinationId" uuid,
    "indexedAt" timestamp with time zone,
    "captionModel" character varying,
    "captionConfigHash" character varying,
    "captionIdentityHash" character varying,
    "captionDestinationId" uuid,
    "captionedAt" timestamp with time zone,
    "coverTimestampMs" integer,
    "coverSetById" uuid,
    "coverSetAt" timestamp with time zone,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL
);

CREATE TABLE public.video_stream_segment (
    "variantId" uuid NOT NULL,
    index integer NOT NULL,
    "durationUs" integer NOT NULL
);

CREATE TABLE public.video_stream_session (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "assetId" uuid NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.video_stream_variant (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "sessionId" uuid NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    bitrate integer NOT NULL,
    codec public.video_stream_variant_codec_enum NOT NULL,
    resolution smallint NOT NULL
);

CREATE TABLE public.workflow (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "ownerId" uuid NOT NULL,
    trigger character varying NOT NULL,
    name character varying,
    description character varying,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    logging boolean DEFAULT false NOT NULL
);

CREATE TABLE public.workflow_definition (
    "workflowId" uuid NOT NULL,
    definition jsonb NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.workflow_log_detail (
    "logId" uuid NOT NULL,
    "workflowId" uuid NOT NULL,
    attempt integer DEFAULT 0 NOT NULL,
    "errorCode" character varying,
    error character varying
);

CREATE TABLE public.workflow_run_step (
    "executionId" uuid NOT NULL,
    "stepId" uuid NOT NULL,
    "workflowId" uuid NOT NULL,
    halted boolean DEFAULT false NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.workflow_step (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    "workflowId" uuid NOT NULL,
    "pluginMethodId" uuid NOT NULL,
    config jsonb,
    "order" integer NOT NULL
);

ALTER TABLE ONLY public.socket_io_attachments ALTER COLUMN id SET DEFAULT nextval('public.socket_io_attachments_id_seq'::regclass);

ALTER TABLE ONLY public.move_history
    ADD CONSTRAINT "UQ_entityId_pathType" UNIQUE ("entityId", "pathType");

ALTER TABLE ONLY public.move_history
    ADD CONSTRAINT "UQ_newPath" UNIQUE ("newPath");

ALTER TABLE ONLY public.activity
    ADD CONSTRAINT activity_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.admin_audit_event
    ADD CONSTRAINT admin_audit_event_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.album_asset_audit
    ADD CONSTRAINT album_asset_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.album_asset
    ADD CONSTRAINT album_asset_pkey PRIMARY KEY ("albumId", "assetId");

ALTER TABLE ONLY public.album_audit
    ADD CONSTRAINT album_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.album_closure
    ADD CONSTRAINT album_closure_pkey PRIMARY KEY (id_ancestor, id_descendant);

ALTER TABLE ONLY public.album_cover_follows_newest
    ADD CONSTRAINT album_cover_follows_newest_pkey PRIMARY KEY ("albumId");

ALTER TABLE ONLY public.album_origin
    ADD CONSTRAINT album_origin_pkey PRIMARY KEY ("albumId");

ALTER TABLE ONLY public.album
    ADD CONSTRAINT album_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.album_position
    ADD CONSTRAINT album_position_pkey PRIMARY KEY ("userId", "albumId");

ALTER TABLE ONLY public.album_source_asset
    ADD CONSTRAINT album_source_asset_pkey PRIMARY KEY ("linkId", "assetId");

ALTER TABLE ONLY public.album_source_link
    ADD CONSTRAINT album_source_link_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.album_user_audit
    ADD CONSTRAINT album_user_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.album_user
    ADD CONSTRAINT album_user_pkey PRIMARY KEY ("albumId", "userId");

ALTER TABLE ONLY public.api_key
    ADD CONSTRAINT api_key_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.archive_operation_item
    ADD CONSTRAINT archive_operation_item_pkey PRIMARY KEY ("operationId", "assetId");

ALTER TABLE ONLY public.archive_operation
    ADD CONSTRAINT "archive_operation_ownerId_requestKey_key" UNIQUE ("ownerId", "requestKey");

ALTER TABLE ONLY public.archive_operation
    ADD CONSTRAINT archive_operation_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.asset_audit
    ADD CONSTRAINT asset_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.asset_backup_deletion
    ADD CONSTRAINT asset_backup_deletion_pkey PRIMARY KEY ("assetId");

ALTER TABLE ONLY public.asset_best_photo_score
    ADD CONSTRAINT asset_best_photo_score_pkey PRIMARY KEY ("assetId");

ALTER TABLE ONLY public.asset_checksum
    ADD CONSTRAINT asset_checksum_pkey PRIMARY KEY ("assetId");

ALTER TABLE ONLY public.asset_develop_artifact
    ADD CONSTRAINT asset_develop_artifact_pkey PRIMARY KEY ("assetId", id);

ALTER TABLE ONLY public.asset_develop_revision
    ADD CONSTRAINT "asset_develop_revision_assetId_revision_key" UNIQUE ("assetId", revision);

ALTER TABLE ONLY public.asset_develop_revision
    ADD CONSTRAINT asset_develop_revision_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.asset_document_edit
    ADD CONSTRAINT "asset_document_edit_assetId_key_uq" UNIQUE ("assetId", key);

ALTER TABLE ONLY public.asset_document_edit
    ADD CONSTRAINT asset_document_edit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.asset_edit
    ADD CONSTRAINT "asset_edit_assetId_sequence_uq" UNIQUE ("assetId", sequence);

ALTER TABLE ONLY public.asset_edit_audit
    ADD CONSTRAINT asset_edit_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.asset_edit
    ADD CONSTRAINT asset_edit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.asset_exif
    ADD CONSTRAINT asset_exif_pkey PRIMARY KEY ("assetId");

ALTER TABLE ONLY public.asset_face_audit
    ADD CONSTRAINT asset_face_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.asset_face
    ADD CONSTRAINT asset_face_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.asset_file
    ADD CONSTRAINT "asset_file_assetId_type_isEdited_uq" UNIQUE ("assetId", type, "isEdited");

ALTER TABLE ONLY public.asset_file
    ADD CONSTRAINT asset_file_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.asset_health
    ADD CONSTRAINT "asset_health_assetId_category_uq" UNIQUE ("assetId", category);

ALTER TABLE ONLY public.asset_health_candidate
    ADD CONSTRAINT "asset_health_candidate_healthId_candidatePath_uq" UNIQUE ("healthId", "candidatePath");

ALTER TABLE ONLY public.asset_health_candidate
    ADD CONSTRAINT asset_health_candidate_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.asset_health
    ADD CONSTRAINT asset_health_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.asset_health_run
    ADD CONSTRAINT asset_health_run_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.asset_integrity_verification
    ADD CONSTRAINT asset_integrity_verification_pkey PRIMARY KEY ("assetId");

ALTER TABLE ONLY public.asset_job_status
    ADD CONSTRAINT asset_job_status_pkey PRIMARY KEY ("assetId");

ALTER TABLE ONLY public.asset_lock
    ADD CONSTRAINT asset_lock_pkey PRIMARY KEY ("assetId");

ALTER TABLE ONLY public.asset_metadata_audit
    ADD CONSTRAINT asset_metadata_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.asset_metadata
    ADD CONSTRAINT asset_metadata_pkey PRIMARY KEY ("assetId", key);

ALTER TABLE ONLY public.asset_ocr_audit
    ADD CONSTRAINT asset_ocr_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.asset_ocr
    ADD CONSTRAINT asset_ocr_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.asset_origin
    ADD CONSTRAINT asset_origin_pkey PRIMARY KEY ("assetId");

ALTER TABLE ONLY public.asset
    ADD CONSTRAINT asset_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.asset_restoration
    ADD CONSTRAINT "asset_restoration_assetId_revision_uq" UNIQUE ("assetId", revision);

ALTER TABLE ONLY public.asset_restoration
    ADD CONSTRAINT asset_restoration_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.asset_upload_part
    ADD CONSTRAINT asset_upload_part_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.asset_upload_resource
    ADD CONSTRAINT asset_upload_resource_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.asset_user_share
    ADD CONSTRAINT asset_user_share_asset_recipient_key UNIQUE ("assetId", "sharedWithId");

ALTER TABLE ONLY public.asset_user_share
    ADD CONSTRAINT asset_user_share_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.asset_video_duplicate_frame
    ADD CONSTRAINT asset_video_duplicate_frame_pkey PRIMARY KEY ("assetId", "frameIndex");

ALTER TABLE ONLY public.backup_device
    ADD CONSTRAINT "backup_device_ownerId_deviceKey_uq" UNIQUE ("ownerId", "deviceKey");

ALTER TABLE ONLY public.backup_device
    ADD CONSTRAINT backup_device_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.backup_reconciliation
    ADD CONSTRAINT backup_reconciliation_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.buddy_backup_reference
    ADD CONSTRAINT buddy_backup_reference_pkey PRIMARY KEY ("runId", path);

ALTER TABLE ONLY public.classification_match
    ADD CONSTRAINT classification_match_pkey PRIMARY KEY ("ruleId", "assetId");

ALTER TABLE ONLY public.classification_rule
    ADD CONSTRAINT "classification_rule_albumId_uq" UNIQUE ("albumId");

ALTER TABLE ONLY public.classification_rule
    ADD CONSTRAINT classification_rule_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.cloud_backup_manifest_entry
    ADD CONSTRAINT cloud_backup_manifest_entry_pkey PRIMARY KEY ("manifestId", "fileKey");

ALTER TABLE ONLY public.cloud_backup_manifest_original
    ADD CONSTRAINT cloud_backup_manifest_original_pkey PRIMARY KEY ("manifestId", "assetId");

ALTER TABLE ONLY public.cloud_backup_manifest
    ADD CONSTRAINT cloud_backup_manifest_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.cloud_backup_object
    ADD CONSTRAINT cloud_backup_object_pkey PRIMARY KEY (bucket, sha256);

ALTER TABLE ONLY public.cloud_backup_object_verification
    ADD CONSTRAINT cloud_backup_object_verification_pkey PRIMARY KEY (bucket, sha256, "operationId");

ALTER TABLE ONLY public.cluster_group
    ADD CONSTRAINT cluster_group_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.cluster_group_request
    ADD CONSTRAINT "cluster_group_request_clusterGroupId_userId_uq" UNIQUE ("clusterGroupId", "userId");

ALTER TABLE ONLY public.cluster_group_request
    ADD CONSTRAINT cluster_group_request_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.develop_export
    ADD CONSTRAINT develop_export_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.develop_preset
    ADD CONSTRAINT "develop_preset_ownerId_name_uq" UNIQUE ("ownerId", name);

ALTER TABLE ONLY public.develop_preset
    ADD CONSTRAINT develop_preset_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.duplicate_decision
    ADD CONSTRAINT "duplicate_decision_operationId_duplicateId_uq" UNIQUE ("operationId", "duplicateId");

ALTER TABLE ONLY public.duplicate_decision
    ADD CONSTRAINT duplicate_decision_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.face_correction
    ADD CONSTRAINT face_correction_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.face_search
    ADD CONSTRAINT face_search_pkey PRIMARY KEY ("faceId");

ALTER TABLE ONLY public.frameleaf_account_link
    ADD CONSTRAINT frameleaf_account_link_pkey PRIMARY KEY ("userId");

ALTER TABLE ONLY public.frameleaf_account_link
    ADD CONSTRAINT frameleaf_account_link_sub_unique UNIQUE (sub);

ALTER TABLE ONLY public.frameleaf_consent
    ADD CONSTRAINT frameleaf_consent_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.frameleaf_exchange_token
    ADD CONSTRAINT frameleaf_exchange_token_pkey PRIMARY KEY (jti);

ALTER TABLE ONLY public.frameleaf_immich_import_checkpoint
    ADD CONSTRAINT frameleaf_immich_import_checkpoint_pkey PRIMARY KEY (table_name);

ALTER TABLE ONLY public.frameleaf_immich_import
    ADD CONSTRAINT frameleaf_immich_import_pkey PRIMARY KEY (singleton);

ALTER TABLE ONLY public.frameleaf_immich_import_work
    ADD CONSTRAINT frameleaf_immich_import_work_pkey PRIMARY KEY (asset_id, kind);

ALTER TABLE ONLY public.frameleaf_rate_limit
    ADD CONSTRAINT frameleaf_rate_limit_pkey PRIMARY KEY (key);

ALTER TABLE ONLY public.frameleaf_session
    ADD CONSTRAINT frameleaf_session_handoff_unique UNIQUE ("handoffCodeHash");

ALTER TABLE ONLY public.frameleaf_session
    ADD CONSTRAINT frameleaf_session_pkey PRIMARY KEY ("sessionId");

ALTER TABLE ONLY public.frameleaf_sign_in_revocation
    ADD CONSTRAINT frameleaf_sign_in_revocation_pkey PRIMARY KEY (kind, value);

ALTER TABLE ONLY public.frameleaf_upload_lease
    ADD CONSTRAINT frameleaf_upload_lease_pkey PRIMARY KEY (key);

ALTER TABLE ONLY public.frameleaf_user_license
    ADD CONSTRAINT frameleaf_user_license_key_unique UNIQUE ("keySha256");

ALTER TABLE ONLY public.frameleaf_user_license
    ADD CONSTRAINT frameleaf_user_license_pkey PRIMARY KEY ("userId");

ALTER TABLE ONLY public.frameleaf_websocket_worker
    ADD CONSTRAINT frameleaf_websocket_worker_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.geodata_places
    ADD CONSTRAINT geodata_places_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.icloud_album
    ADD CONSTRAINT icloud_album_pkey PRIMARY KEY ("connectionId", "libraryKey", "sourceId");

ALTER TABLE ONLY public.icloud_identity_audit
    ADD CONSTRAINT icloud_audit_weekly_binding UNIQUE (id, "cohortId", "memberOrdinal", "ownerId", "connectionId", "grantId", "grantGeneration", "batchOrdinal");

ALTER TABLE ONLY public.icloud_checkpoint
    ADD CONSTRAINT icloud_checkpoint_pkey PRIMARY KEY ("connectionId", scope);

ALTER TABLE ONLY public.icloud_claim
    ADD CONSTRAINT icloud_claim_id_key UNIQUE (id);

ALTER TABLE ONLY public.icloud_claim
    ADD CONSTRAINT icloud_claim_pkey PRIMARY KEY ("ownerId", "cplAssetRecordName");

ALTER TABLE ONLY public.icloud_connection
    ADD CONSTRAINT "icloud_connection_id_ownerId_key" UNIQUE (id, "ownerId");

ALTER TABLE ONLY public.icloud_connection
    ADD CONSTRAINT icloud_connection_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.icloud_identity_audit
    ADD CONSTRAINT icloud_identity_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.icloud_identity_reuse
    ADD CONSTRAINT icloud_identity_reuse_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.icloud_identity_reuse
    ADD CONSTRAINT "icloud_identity_reuse_sourceResourceId_key" UNIQUE ("sourceResourceId");

ALTER TABLE ONLY public.icloud_membership
    ADD CONSTRAINT icloud_membership_pkey PRIMARY KEY ("connectionId", "libraryKey", "sourceAlbumId", "sourceAssetId");

ALTER TABLE ONLY public.icloud_record
    ADD CONSTRAINT icloud_record_pkey PRIMARY KEY ("connectionId", "libraryKey", "recordId");

ALTER TABLE ONLY public.icloud_resource
    ADD CONSTRAINT icloud_resource_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.icloud_run
    ADD CONSTRAINT icloud_run_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.icloud_source_identity
    ADD CONSTRAINT icloud_source_identity_key UNIQUE ("ownerId", "cplAssetRecordName", role, "editVersion", "assetId");

ALTER TABLE ONLY public.icloud_source_identity
    ADD CONSTRAINT icloud_source_identity_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.icloud_weekly_cohort
    ADD CONSTRAINT "icloud_weekly_cohort_id_ownerId_connectionId_grantId_grantG_key" UNIQUE (id, "ownerId", "connectionId", "grantId", "grantGeneration");

ALTER TABLE ONLY public.icloud_weekly_cohort
    ADD CONSTRAINT "icloud_weekly_cohort_id_ownerId_connectionId_key" UNIQUE (id, "ownerId", "connectionId");

ALTER TABLE ONLY public.icloud_weekly_cohort
    ADD CONSTRAINT "icloud_weekly_cohort_ownerId_connectionId_weekStart_key" UNIQUE ("ownerId", "connectionId", "weekStart");

ALTER TABLE ONLY public.icloud_weekly_cohort
    ADD CONSTRAINT icloud_weekly_cohort_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.icloud_weekly_grant
    ADD CONSTRAINT "icloud_weekly_grant_connectionId_ownerId_key" UNIQUE ("connectionId", "ownerId");

ALTER TABLE ONLY public.icloud_weekly_grant
    ADD CONSTRAINT "icloud_weekly_grant_id_ownerId_connectionId_key" UNIQUE (id, "ownerId", "connectionId");

ALTER TABLE ONLY public.icloud_weekly_grant
    ADD CONSTRAINT icloud_weekly_grant_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.icloud_weekly_member
    ADD CONSTRAINT "icloud_weekly_member_auditRequestId_key" UNIQUE ("auditRequestId");

ALTER TABLE ONLY public.icloud_weekly_member
    ADD CONSTRAINT "icloud_weekly_member_cohortId_ordinal_ownerId_connectionId__key" UNIQUE ("cohortId", ordinal, "ownerId", "connectionId", "grantId", "grantGeneration", "batchOrdinal");

ALTER TABLE ONLY public.icloud_weekly_member
    ADD CONSTRAINT "icloud_weekly_member_cohortId_receiptId_key" UNIQUE ("cohortId", "receiptId");

ALTER TABLE ONLY public.icloud_weekly_member
    ADD CONSTRAINT "icloud_weekly_member_cohortId_resourceRoleKey_key" UNIQUE ("cohortId", "resourceRoleKey");

ALTER TABLE ONLY public.icloud_weekly_member
    ADD CONSTRAINT icloud_weekly_member_pkey PRIMARY KEY ("cohortId", ordinal);

ALTER TABLE ONLY public.integrity_report
    ADD CONSTRAINT integrity_report_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.integrity_report
    ADD CONSTRAINT integrity_report_type_path_uq UNIQUE (type, path);

ALTER TABLE ONLY public.job_attempt
    ADD CONSTRAINT job_attempt_pkey PRIMARY KEY ("jobId", attempt);

ALTER TABLE ONLY public.job_attempt
    ADD CONSTRAINT job_attempt_token_key UNIQUE (token);

ALTER TABLE ONLY public.job
    ADD CONSTRAINT job_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.job_queue
    ADD CONSTRAINT job_queue_pkey PRIMARY KEY (name);

ALTER TABLE ONLY public.job_run_item
    ADD CONSTRAINT job_run_item_pkey PRIMARY KEY ("runId", "itemKey", stage);

ALTER TABLE ONLY public.job_run
    ADD CONSTRAINT job_run_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.job_selection
    ADD CONSTRAINT job_selection_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.job_selection
    ADD CONSTRAINT "job_selection_producerId_stage_key" UNIQUE ("producerId", stage);

ALTER TABLE ONLY public.job_selection
    ADD CONSTRAINT "job_selection_runId_stage_key" UNIQUE ("runId", stage);

ALTER TABLE ONLY public.job_worker
    ADD CONSTRAINT job_worker_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.library
    ADD CONSTRAINT library_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.media_operation_checkpoint
    ADD CONSTRAINT "media_operation_checkpoint_operationId_sequence_uq" UNIQUE ("operationId", sequence);

ALTER TABLE ONLY public.media_operation_checkpoint
    ADD CONSTRAINT media_operation_checkpoint_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.media_operation
    ADD CONSTRAINT media_operation_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.memory_asset_audit
    ADD CONSTRAINT memory_asset_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.memory_asset
    ADD CONSTRAINT memory_asset_pkey PRIMARY KEY ("memoriesId", "assetId");

ALTER TABLE ONLY public.memory_audit
    ADD CONSTRAINT memory_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.memory_curation
    ADD CONSTRAINT memory_curation_pkey PRIMARY KEY ("memoryId");

ALTER TABLE ONLY public.memory_export
    ADD CONSTRAINT memory_export_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.memory
    ADD CONSTRAINT memory_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.memory_show_less
    ADD CONSTRAINT memory_show_less_pkey PRIMARY KEY ("userId", kind, value);

ALTER TABLE ONLY public.ml_cloud_model_choice
    ADD CONSTRAINT ml_cloud_model_choice_pkey PRIMARY KEY ("modelGroup");

ALTER TABLE ONLY public.ml_destination
    ADD CONSTRAINT ml_destination_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ml_workload_accounting
    ADD CONSTRAINT ml_workload_accounting_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ml_workload_route
    ADD CONSTRAINT ml_workload_route_pkey PRIMARY KEY (workload);

ALTER TABLE ONLY public.move_history
    ADD CONSTRAINT move_history_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.naturalearth_countries
    ADD CONSTRAINT naturalearth_countries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.notification
    ADD CONSTRAINT notification_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ocr_search
    ADD CONSTRAINT ocr_search_pkey PRIMARY KEY ("assetId");

ALTER TABLE ONLY public.operational_metric_sample
    ADD CONSTRAINT operational_metric_sample_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.operational_metric_sample
    ADD CONSTRAINT "operational_metric_sample_series_scopeKey_grain_bucketStart_uq" UNIQUE (series, "scopeKey", grain, "bucketStart");

ALTER TABLE ONLY public.partner_audit
    ADD CONSTRAINT partner_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.partner_backfill
    ADD CONSTRAINT partner_backfill_pkey PRIMARY KEY ("sharedById", "sharedWithId");

ALTER TABLE ONLY public.partner_person_link
    ADD CONSTRAINT partner_person_link_pkey PRIMARY KEY ("ownerId", "sourcePersonGroupId");

ALTER TABLE ONLY public.partner
    ADD CONSTRAINT partner_pkey PRIMARY KEY ("sharedById", "sharedWithId");

ALTER TABLE ONLY public.person_audit
    ADD CONSTRAINT person_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.person_group_audit
    ADD CONSTRAINT person_group_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.person_group
    ADD CONSTRAINT person_group_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.person_merge_verdict
    ADD CONSTRAINT person_merge_verdict_pkey PRIMARY KEY ("ownerId", "personId", "suggestionId");

ALTER TABLE ONLY public.person_origin
    ADD CONSTRAINT person_origin_pkey PRIMARY KEY ("ownerId", "personGroupId");

ALTER TABLE ONLY public.person_origin
    ADD CONSTRAINT person_origin_source_key UNIQUE ("ownerId", "sourcePersonGroupId");

ALTER TABLE ONLY public.person
    ADD CONSTRAINT person_pkey PRIMARY KEY ("ownerId", "personGroupId");

ALTER TABLE ONLY public.pet_audit
    ADD CONSTRAINT pet_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pet_candidate
    ADD CONSTRAINT "pet_candidate_detectionId_petId_uq" UNIQUE ("detectionId", "petId");

ALTER TABLE ONLY public.pet_candidate
    ADD CONSTRAINT pet_candidate_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pet_detection
    ADD CONSTRAINT pet_detection_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pet_observation_audit
    ADD CONSTRAINT pet_observation_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pet_observation
    ADD CONSTRAINT "pet_observation_petId_assetId_uq" UNIQUE ("petId", "assetId");

ALTER TABLE ONLY public.pet_observation
    ADD CONSTRAINT pet_observation_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pet
    ADD CONSTRAINT pet_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pet_recognition_run
    ADD CONSTRAINT pet_recognition_run_pkey PRIMARY KEY ("ownerId");

ALTER TABLE ONLY public.photography_studio_site
    ADD CONSTRAINT photography_studio_site_pkey PRIMARY KEY ("ownerId");

ALTER TABLE ONLY public.photography_workflow
    ADD CONSTRAINT photography_workflow_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.physical_file
    ADD CONSTRAINT physical_file_path_uq UNIQUE (path);

ALTER TABLE ONLY public.physical_file
    ADD CONSTRAINT physical_file_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.physical_file_trash
    ADD CONSTRAINT physical_file_trash_path_key UNIQUE (path);

ALTER TABLE ONLY public.physical_file_trash
    ADD CONSTRAINT physical_file_trash_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.plugin_method
    ADD CONSTRAINT plugin_method_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.plugin_method
    ADD CONSTRAINT "plugin_method_pluginId_name_uq" UNIQUE ("pluginId", name);

ALTER TABLE ONLY public.plugin
    ADD CONSTRAINT plugin_name_uq UNIQUE (name);

ALTER TABLE ONLY public.plugin
    ADD CONSTRAINT plugin_name_version_uq UNIQUE (name, version);

ALTER TABLE ONLY public.plugin
    ADD CONSTRAINT plugin_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.preservation_item
    ADD CONSTRAINT "preservation_item_packageId_sourceAssetId_uq" UNIQUE ("packageId", "sourceAssetId");

ALTER TABLE ONLY public.preservation_item
    ADD CONSTRAINT preservation_item_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.preservation_package
    ADD CONSTRAINT preservation_package_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.preservation_restore_item
    ADD CONSTRAINT preservation_restore_item_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.preservation_restore_item
    ADD CONSTRAINT "preservation_restore_item_restoreId_sourceAssetId_uq" UNIQUE ("restoreId", "sourceAssetId");

ALTER TABLE ONLY public.preservation_restore
    ADD CONSTRAINT preservation_restore_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.push_device_activity
    ADD CONSTRAINT "push_device_activity_deviceId_activityId_uq" UNIQUE ("deviceId", "activityId");

ALTER TABLE ONLY public.push_device_activity
    ADD CONSTRAINT push_device_activity_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.push_device
    ADD CONSTRAINT push_device_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.push_device
    ADD CONSTRAINT "push_device_sessionId_uq" UNIQUE ("sessionId");

ALTER TABLE ONLY public.recipient_group
    ADD CONSTRAINT recipient_group_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.render_worker_audit
    ADD CONSTRAINT render_worker_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.render_worker_limit
    ADD CONSTRAINT render_worker_limit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.render_worker_limit
    ADD CONSTRAINT render_worker_limit_subject_uq UNIQUE (subject);

ALTER TABLE ONLY public.render_worker
    ADD CONSTRAINT render_worker_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.render_worker_session_capability
    ADD CONSTRAINT render_worker_session_capability_pkey PRIMARY KEY ("sessionId");

ALTER TABLE ONLY public.render_worker_session
    ADD CONSTRAINT render_worker_session_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.session_sync_checkpoint
    ADD CONSTRAINT session_sync_checkpoint_pkey PRIMARY KEY ("sessionId", type);

ALTER TABLE ONLY public.session_tag_sync_state
    ADD CONSTRAINT session_tag_sync_state_pkey PRIMARY KEY ("sessionId", kind, key);

ALTER TABLE ONLY public.shared_link_asset
    ADD CONSTRAINT shared_link_asset_pkey PRIMARY KEY ("assetId", "sharedLinkId");

ALTER TABLE ONLY public.shared_link
    ADD CONSTRAINT shared_link_key_uq UNIQUE (key);

ALTER TABLE ONLY public.shared_link
    ADD CONSTRAINT shared_link_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.shared_link
    ADD CONSTRAINT shared_link_slug_uq UNIQUE (slug);

ALTER TABLE ONLY public.shared_space_album
    ADD CONSTRAINT shared_space_album_pkey PRIMARY KEY ("albumId", "linkedAlbumId");

ALTER TABLE ONLY public.shared_space_comment_thread
    ADD CONSTRAINT shared_space_comment_thread_pkey PRIMARY KEY ("activityId");

ALTER TABLE ONLY public.shared_space_event
    ADD CONSTRAINT shared_space_event_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.shared_space_invite
    ADD CONSTRAINT shared_space_invite_pkey PRIMARY KEY ("albumId", "userId");

ALTER TABLE ONLY public.shared_space_mention
    ADD CONSTRAINT shared_space_mention_pkey PRIMARY KEY ("activityId", "userId");

ALTER TABLE ONLY public.shared_space_person
    ADD CONSTRAINT "shared_space_person_albumId_personOwnerId_personGroupId_uq" UNIQUE ("albumId", "personOwnerId", "personGroupId");

ALTER TABLE ONLY public.shared_space_person
    ADD CONSTRAINT shared_space_person_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.shared_space_visit
    ADD CONSTRAINT shared_space_visit_pkey PRIMARY KEY ("albumId", "userId");

ALTER TABLE ONLY public.smart_album_asset
    ADD CONSTRAINT smart_album_asset_pkey PRIMARY KEY ("smartAlbumId", "assetId");

ALTER TABLE ONLY public.smart_album_exclusion
    ADD CONSTRAINT smart_album_exclusion_pkey PRIMARY KEY ("smartAlbumId", "assetId");

ALTER TABLE ONLY public.smart_album
    ADD CONSTRAINT "smart_album_ownerId_kind_uq" UNIQUE ("ownerId", kind);

ALTER TABLE ONLY public.smart_album
    ADD CONSTRAINT smart_album_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.smart_search_description
    ADD CONSTRAINT smart_search_description_pkey PRIMARY KEY ("assetId");

ALTER TABLE ONLY public.smart_search
    ADD CONSTRAINT smart_search_pkey PRIMARY KEY ("assetId");

ALTER TABLE ONLY public.socket_io_attachments
    ADD CONSTRAINT socket_io_attachments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.stack_audit
    ADD CONSTRAINT stack_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.stack
    ADD CONSTRAINT stack_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.stack
    ADD CONSTRAINT "stack_primaryAssetId_uq" UNIQUE ("primaryAssetId");

ALTER TABLE ONLY public.studio_bundle_upload
    ADD CONSTRAINT studio_bundle_upload_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.studio_export_remote_reference
    ADD CONSTRAINT "studio_export_remote_reference_operationId_workerId_reason_uq" UNIQUE ("operationId", "workerId", reason);

ALTER TABLE ONLY public.studio_export_remote_reference
    ADD CONSTRAINT studio_export_remote_reference_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.studio_export_version
    ADD CONSTRAINT studio_export_version_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.studio_export_version
    ADD CONSTRAINT "studio_export_version_projectId_version_uq" UNIQUE ("projectId", version);

ALTER TABLE ONLY public.studio_export_version
    ADD CONSTRAINT "studio_export_version_renderOperationId_uq" UNIQUE ("renderOperationId");

ALTER TABLE ONLY public.studio_export_version_source
    ADD CONSTRAINT studio_export_version_source_pkey PRIMARY KEY ("versionId", key);

ALTER TABLE ONLY public.studio_generated_resource
    ADD CONSTRAINT studio_generated_resource_pkey PRIMARY KEY ("projectId", id);

ALTER TABLE ONLY public.studio_hdr_intermediate
    ADD CONSTRAINT studio_hdr_intermediate_path_uq UNIQUE (path);

ALTER TABLE ONLY public.studio_hdr_intermediate
    ADD CONSTRAINT studio_hdr_intermediate_pkey PRIMARY KEY ("assetId");

ALTER TABLE ONLY public.studio_preview_frame
    ADD CONSTRAINT "studio_preview_frame_cacheKey_uq" UNIQUE ("cacheKey");

ALTER TABLE ONLY public.studio_preview_frame
    ADD CONSTRAINT studio_preview_frame_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.studio_project_comment
    ADD CONSTRAINT studio_project_comment_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.studio_project_comment
    ADD CONSTRAINT "studio_project_comment_projectId_requestKey_uq" UNIQUE ("projectId", "requestKey");

ALTER TABLE ONLY public.studio_project
    ADD CONSTRAINT "studio_project_importOperationId_uq" UNIQUE ("importOperationId");

ALTER TABLE ONLY public.studio_project_import
    ADD CONSTRAINT studio_project_import_pkey PRIMARY KEY ("projectId", id);

ALTER TABLE ONLY public.studio_project
    ADD CONSTRAINT studio_project_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.studio_project_revision
    ADD CONSTRAINT studio_project_revision_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.studio_project_revision
    ADD CONSTRAINT "studio_project_revision_projectId_requestKey_uq" UNIQUE ("projectId", "requestKey");

ALTER TABLE ONLY public.studio_project_revision
    ADD CONSTRAINT "studio_project_revision_projectId_revision_uq" UNIQUE ("projectId", revision);

ALTER TABLE ONLY public.studio_workspace_layout
    ADD CONSTRAINT studio_workspace_layout_pkey PRIMARY KEY ("userId");

ALTER TABLE ONLY public.system_metadata
    ADD CONSTRAINT system_metadata_pkey PRIMARY KEY (key);

ALTER TABLE ONLY public.tag_asset_audit
    ADD CONSTRAINT tag_asset_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.tag_asset
    ADD CONSTRAINT tag_asset_pkey PRIMARY KEY ("assetId", "tagId");

ALTER TABLE ONLY public.tag_audit
    ADD CONSTRAINT tag_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.tag_closure
    ADD CONSTRAINT tag_closure_pkey PRIMARY KEY (id_ancestor, id_descendant);

ALTER TABLE ONLY public.tag
    ADD CONSTRAINT tag_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.tag
    ADD CONSTRAINT "tag_userId_value_uq" UNIQUE ("userId", value);

ALTER TABLE ONLY public.takeout_album
    ADD CONSTRAINT "takeout_album_ownerId_folder_uq" UNIQUE ("ownerId", folder);

ALTER TABLE ONLY public.takeout_album
    ADD CONSTRAINT takeout_album_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.takeout_file
    ADD CONSTRAINT takeout_file_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.takeout_file
    ADD CONSTRAINT "takeout_file_sourceId_entryName_uq" UNIQUE ("sourceId", "entryName");

ALTER TABLE ONLY public.takeout_import
    ADD CONSTRAINT takeout_import_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.takeout_item
    ADD CONSTRAINT takeout_item_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.takeout_pair
    ADD CONSTRAINT "takeout_pair_photoItemId_videoItemId_uq" UNIQUE ("photoItemId", "videoItemId");

ALTER TABLE ONLY public.takeout_pair
    ADD CONSTRAINT takeout_pair_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.takeout_source
    ADD CONSTRAINT takeout_source_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.user_audit
    ADD CONSTRAINT user_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_email_uq UNIQUE (email);

ALTER TABLE ONLY public.user_metadata_audit
    ADD CONSTRAINT user_metadata_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.user_metadata
    ADD CONSTRAINT user_metadata_pkey PRIMARY KEY ("userId", key);

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.user_preference_history
    ADD CONSTRAINT user_preference_history_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT "user_storageLabel_uq" UNIQUE ("storageLabel");

ALTER TABLE ONLY public.utility_activity
    ADD CONSTRAINT utility_activity_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.version_history
    ADD CONSTRAINT version_history_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.video_edit_selection
    ADD CONSTRAINT video_edit_selection_pkey PRIMARY KEY ("assetId");

ALTER TABLE ONLY public.video_edit_version
    ADD CONSTRAINT "video_edit_version_id_assetId_ownerId_key" UNIQUE (id, "assetId", "ownerId");

ALTER TABLE ONLY public.video_edit_version
    ADD CONSTRAINT video_edit_version_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.video_moment_frame
    ADD CONSTRAINT "video_moment_frame_assetId_frameIndex_uq" UNIQUE ("assetId", "frameIndex");

ALTER TABLE ONLY public.video_moment_frame_embedding
    ADD CONSTRAINT video_moment_frame_embedding_pkey PRIMARY KEY ("frameId");

ALTER TABLE ONLY public.video_moment_frame
    ADD CONSTRAINT video_moment_frame_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.video_moment_index
    ADD CONSTRAINT video_moment_index_pkey PRIMARY KEY ("assetId");

ALTER TABLE ONLY public.video_moment
    ADD CONSTRAINT video_moment_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.video_stream_segment
    ADD CONSTRAINT video_stream_segment_pkey PRIMARY KEY ("variantId", index);

ALTER TABLE ONLY public.video_stream_session
    ADD CONSTRAINT video_stream_session_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.video_stream_variant
    ADD CONSTRAINT video_stream_variant_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.workflow_definition
    ADD CONSTRAINT workflow_definition_pkey PRIMARY KEY ("workflowId");

ALTER TABLE ONLY public.workflow_log_detail
    ADD CONSTRAINT workflow_log_detail_pkey PRIMARY KEY ("logId");

ALTER TABLE ONLY public.workflow
    ADD CONSTRAINT workflow_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.workflow_run_step
    ADD CONSTRAINT workflow_run_step_pkey PRIMARY KEY ("executionId", "stepId");

ALTER TABLE ONLY public.workflow_step
    ADD CONSTRAINT workflow_step_pkey PRIMARY KEY (id);

CREATE INDEX "IDX_asset_exif_gist_earthcoord" ON public.asset_exif USING gist (public.ll_to_earth_public(latitude, longitude));

CREATE INDEX "IDX_geodata_gist_earthcoord" ON public.geodata_places USING btree (public.ll_to_earth_public(latitude, longitude));

CREATE INDEX "IDX_user_metadata_audit_deleted_at" ON public.user_metadata_audit USING btree ("deletedAt");

CREATE INDEX "IDX_user_metadata_audit_key" ON public.user_metadata_audit USING btree (key);

CREATE INDEX "IDX_user_metadata_audit_user_id" ON public.user_metadata_audit USING btree ("userId");

CREATE INDEX "IDX_user_metadata_update_id" ON public.user_metadata USING btree ("updateId");

CREATE INDEX "IDX_user_metadata_updated_at" ON public.user_metadata USING btree ("updatedAt");

CREATE UNIQUE INDEX "UQ_assets_owner_checksum" ON public.asset USING btree ("ownerId", checksum) WHERE ("libraryId" IS NULL);

CREATE INDEX "activity_albumId_assetId_idx" ON public.activity USING btree ("albumId", "assetId");

CREATE INDEX "activity_albumId_idx" ON public.activity USING btree ("albumId");

CREATE INDEX "activity_assetId_idx" ON public.activity USING btree ("assetId");

CREATE UNIQUE INDEX activity_like_idx ON public.activity USING btree ("assetId", "userId", "albumId") WHERE ("isLiked" = true);

CREATE INDEX "activity_updateId_idx" ON public.activity USING btree ("updateId");

CREATE INDEX "activity_userId_idx" ON public.activity USING btree ("userId");

CREATE INDEX "admin_audit_event_actorId_idx" ON public.admin_audit_event USING btree ("actorId");

CREATE INDEX "admin_audit_event_libraryId_idx" ON public.admin_audit_event USING btree ("libraryId");

CREATE INDEX "admin_audit_event_userId_createdAt_idx" ON public.admin_audit_event USING btree ("userId", "createdAt");

CREATE INDEX "admin_audit_event_userId_idx" ON public.admin_audit_event USING btree ("userId");

CREATE INDEX "album_albumThumbnailAssetId_idx" ON public.album USING btree ("albumThumbnailAssetId");

CREATE INDEX "album_asset_albumId_idx" ON public.album_asset USING btree ("albumId");

CREATE INDEX "album_asset_assetId_idx" ON public.album_asset USING btree ("assetId");

CREATE INDEX "album_asset_audit_albumId_idx" ON public.album_asset_audit USING btree ("albumId");

CREATE INDEX "album_asset_audit_assetId_idx" ON public.album_asset_audit USING btree ("assetId");

CREATE INDEX "album_asset_audit_deletedAt_idx" ON public.album_asset_audit USING btree ("deletedAt");

CREATE INDEX "album_asset_updateId_idx" ON public.album_asset USING btree ("updateId");

CREATE INDEX "album_audit_albumId_idx" ON public.album_audit USING btree ("albumId");

CREATE INDEX "album_audit_deletedAt_idx" ON public.album_audit USING btree ("deletedAt");

CREATE INDEX "album_audit_userId_idx" ON public.album_audit USING btree ("userId");

CREATE INDEX album_closure_id_ancestor_idx ON public.album_closure USING btree (id_ancestor);

CREATE INDEX album_closure_id_descendant_idx ON public.album_closure USING btree (id_descendant);

CREATE INDEX album_origin_partner_idx ON public.album_origin USING btree ("partnerSharedById", "ownerId");

CREATE INDEX album_origin_source_idx ON public.album_origin USING btree ("sourceAlbumId") WHERE following;

CREATE INDEX "album_parentId_idx" ON public.album USING btree ("parentId") WHERE ("parentId" IS NOT NULL);

CREATE INDEX album_parent_sort_idx ON public.album USING btree ("parentId", "sortOrder") WHERE ("parentId" IS NOT NULL);

CREATE INDEX album_root_sort_idx ON public.album USING btree ("sortOrder") WHERE ("parentId" IS NULL);

CREATE INDEX album_source_asset_asset_idx ON public.album_source_asset USING btree ("assetId");

CREATE INDEX album_source_link_album_idx ON public.album_source_link USING btree ("albumId");

CREATE UNIQUE INDEX album_source_link_source_idx ON public.album_source_link USING btree ("userId", "sourceKind", "sourceId", COALESCE("deviceKey", ''::text));

CREATE INDEX "album_updateId_idx" ON public.album USING btree ("updateId");

CREATE INDEX "album_user_albumId_idx" ON public.album_user USING btree ("albumId");

CREATE INDEX "album_user_audit_albumId_idx" ON public.album_user_audit USING btree ("albumId");

CREATE INDEX "album_user_audit_deletedAt_idx" ON public.album_user_audit USING btree ("deletedAt");

CREATE INDEX "album_user_audit_userId_idx" ON public.album_user_audit USING btree ("userId");

CREATE INDEX "album_user_createId_idx" ON public.album_user USING btree ("createId");

CREATE UNIQUE INDEX album_user_unique_owner ON public.album_user USING btree ("albumId") WHERE (role = 'owner'::public.album_user_role_enum);

CREATE INDEX "album_user_updateId_idx" ON public.album_user USING btree ("updateId");

CREATE INDEX "album_user_userId_idx" ON public.album_user USING btree ("userId");

CREATE INDEX api_key_key_idx ON public.api_key USING btree (key);

CREATE INDEX "api_key_updateId_idx" ON public.api_key USING btree ("updateId");

CREATE INDEX "api_key_userId_idx" ON public.api_key USING btree ("userId");

CREATE INDEX archive_operation_owner_created_idx ON public.archive_operation USING btree ("ownerId", "createdAt" DESC);

CREATE INDEX "asset_audit_assetId_idx" ON public.asset_audit USING btree ("assetId");

CREATE INDEX "asset_audit_deletedAt_idx" ON public.asset_audit USING btree ("deletedAt");

CREATE INDEX "asset_audit_ownerId_idx" ON public.asset_audit USING btree ("ownerId");

CREATE INDEX "asset_backup_deletion_livePhotoVideoId_idx" ON public.asset_backup_deletion USING btree ("livePhotoVideoId");

CREATE INDEX "asset_backup_deletion_ownerId_idx" ON public.asset_backup_deletion USING btree ("ownerId");

CREATE INDEX "asset_best_photo_score_computedAt_idx" ON public.asset_best_photo_score USING btree ("computedAt");

CREATE INDEX "asset_best_photo_score_ownerId_idx" ON public.asset_best_photo_score USING btree ("ownerId");

CREATE INDEX "asset_best_photo_score_ownerId_score_idx" ON public.asset_best_photo_score USING btree ("ownerId", score);

CREATE INDEX "asset_best_photo_score_scoreVersion_computedAt_idx" ON public.asset_best_photo_score USING btree ("scoreVersion", "computedAt");

CREATE INDEX asset_checksum_idx ON public.asset USING btree (checksum);

CREATE INDEX asset_checksum_sha256_idx ON public.asset_checksum USING btree (sha256);

CREATE INDEX "asset_createdAt_idx" ON public.asset USING btree ("createdAt");

CREATE INDEX asset_develop_artifact_owner_idx ON public.asset_develop_artifact USING btree ("ownerId");

CREATE UNIQUE INDEX asset_develop_artifact_path_key ON public.asset_develop_artifact USING btree (path);

CREATE INDEX asset_develop_revision_asset_idx ON public.asset_develop_revision USING btree ("assetId", revision DESC);

CREATE UNIQUE INDEX asset_develop_revision_current_idx ON public.asset_develop_revision USING btree ("assetId") WHERE "isCurrent";

CREATE INDEX asset_develop_revision_owner_idx ON public.asset_develop_revision USING btree ("ownerId");

CREATE INDEX "asset_document_edit_editedById_idx" ON public.asset_document_edit USING btree ("editedById");

CREATE INDEX "asset_duplicateId_idx" ON public.asset USING btree ("duplicateId");

CREATE INDEX "asset_edit_assetId_idx" ON public.asset_edit USING btree ("assetId");

CREATE INDEX "asset_edit_audit_assetId_idx" ON public.asset_edit_audit USING btree ("assetId");

CREATE INDEX "asset_edit_audit_deletedAt_idx" ON public.asset_edit_audit USING btree ("deletedAt");

CREATE INDEX "asset_edit_updateId_idx" ON public.asset_edit USING btree ("updateId");

CREATE INDEX "asset_exif_autoStackId_idx" ON public.asset_exif USING btree ("autoStackId");

CREATE INDEX asset_exif_city_idx ON public.asset_exif USING btree (city);

CREATE INDEX "asset_exif_livePhotoCID_idx" ON public.asset_exif USING btree ("livePhotoCID");

CREATE INDEX "asset_exif_updateId_idx" ON public.asset_exif USING btree ("updateId");

CREATE INDEX "asset_face_assetId_personGroupId_idx" ON public.asset_face USING btree ("assetId", "personGroupId");

CREATE INDEX "asset_face_audit_assetFaceId_idx" ON public.asset_face_audit USING btree ("assetFaceId");

CREATE INDEX "asset_face_audit_assetId_idx" ON public.asset_face_audit USING btree ("assetId");

CREATE INDEX "asset_face_audit_deletedAt_idx" ON public.asset_face_audit USING btree ("deletedAt");

CREATE INDEX "asset_face_correctedAt_idx" ON public.asset_face USING btree ("correctedAt");

CREATE INDEX "asset_face_personGroupId_assetId_idx" ON public.asset_face USING btree ("personGroupId", "assetId");

CREATE INDEX "asset_face_personGroupId_assetId_notDeleted_isVisible_idx" ON public.asset_face USING btree ("personGroupId", "assetId") WHERE (("deletedAt" IS NULL) AND ("isVisible" IS TRUE));

CREATE INDEX "asset_fileCreatedAt_idx" ON public.asset USING btree ("fileCreatedAt");

CREATE INDEX "asset_file_assetId_idx" ON public.asset_file USING btree ("assetId");

CREATE INDEX asset_file_path_frameleaf_idx ON public.asset_file USING btree (path);

CREATE INDEX "asset_file_physicalFileId_idx" ON public.asset_file USING btree ("physicalFileId");

CREATE INDEX "asset_file_updateId_idx" ON public.asset_file USING btree ("updateId");

CREATE INDEX "asset_health_assetId_idx" ON public.asset_health USING btree ("assetId");

CREATE INDEX "asset_health_candidate_healthId_idx" ON public.asset_health_candidate USING btree ("healthId");

CREATE INDEX asset_health_category_status_idx ON public.asset_health USING btree (category, status);

CREATE INDEX "asset_health_checkedAt_idx" ON public.asset_health USING btree ("checkedAt");

CREATE INDEX "asset_health_runId_idx" ON public.asset_health USING btree ("runId");

CREATE INDEX "asset_health_run_ownerId_idx" ON public.asset_health_run USING btree ("ownerId");

CREATE INDEX "asset_health_run_ownerId_startedAt_idx" ON public.asset_health_run USING btree ("ownerId", "startedAt");

CREATE INDEX "asset_id_stackId_idx" ON public.asset USING btree (id, "stackId");

CREATE INDEX "asset_id_timeline_notDeleted_idx" ON public.asset USING btree (id) WHERE ((visibility = 'timeline'::public.asset_visibility_enum) AND ("deletedAt" IS NULL));

CREATE INDEX "asset_libraryId_idx" ON public.asset USING btree ("libraryId");

CREATE INDEX "asset_livePhotoVideoId_idx" ON public.asset USING btree ("livePhotoVideoId");

CREATE INDEX "asset_localDateTime_idx" ON public.asset USING btree (((("localDateTime" AT TIME ZONE 'UTC'::text))::date));

CREATE INDEX "asset_localDateTime_month_idx" ON public.asset USING btree ((date_trunc('MONTH'::text, ("localDateTime" AT TIME ZONE 'UTC'::text)) AT TIME ZONE 'UTC'::text));

CREATE INDEX "asset_lock_lockedBy_idx" ON public.asset_lock USING btree ("lockedBy");

CREATE INDEX "asset_metadata_audit_assetId_idx" ON public.asset_metadata_audit USING btree ("assetId");

CREATE INDEX "asset_metadata_audit_deletedAt_idx" ON public.asset_metadata_audit USING btree ("deletedAt");

CREATE INDEX asset_metadata_audit_key_idx ON public.asset_metadata_audit USING btree (key);

CREATE INDEX "asset_metadata_updateId_idx" ON public.asset_metadata USING btree ("updateId");

CREATE INDEX "asset_metadata_updatedAt_idx" ON public.asset_metadata USING btree ("updatedAt");

CREATE INDEX "asset_ocr_assetId_idx" ON public.asset_ocr USING btree ("assetId");

CREATE INDEX "asset_ocr_audit_assetId_idx" ON public.asset_ocr_audit USING btree ("assetId");

CREATE INDEX "asset_ocr_audit_deletedAt_idx" ON public.asset_ocr_audit USING btree ("deletedAt");

CREATE INDEX "asset_ocr_updateId_idx" ON public.asset_ocr USING btree ("updateId");

CREATE INDEX asset_origin_partner_idx ON public.asset_origin USING btree ("partnerSharedById", "ownerId");

CREATE INDEX asset_origin_source_idx ON public.asset_origin USING btree ("sourceAssetId") WHERE following;

CREATE INDEX "asset_originalFileName_idx" ON public.asset USING btree ("originalFileName");

CREATE INDEX "asset_originalFilename_trigram_idx" ON public.asset USING gin (public.f_unaccent(("originalFileName")::text) public.gin_trgm_ops);

CREATE INDEX "asset_originalPath_libraryId_idx" ON public.asset USING btree ("originalPath", "libraryId");

CREATE INDEX "asset_ownerId_idx" ON public.asset USING btree ("ownerId");

CREATE UNIQUE INDEX "asset_ownerId_libraryId_checksum_idx" ON public.asset USING btree ("ownerId", "libraryId", checksum) WHERE ("libraryId" IS NOT NULL);

CREATE INDEX "asset_physicalOriginalFileId_idx" ON public.asset USING btree ("physicalOriginalFileId");

CREATE INDEX "asset_restoration_assetId_idx" ON public.asset_restoration USING btree ("assetId");

CREATE UNIQUE INDEX "asset_restoration_assetId_isCurrent_uq" ON public.asset_restoration USING btree ("assetId") WHERE "isCurrent";

CREATE INDEX "asset_restoration_destinationId_idx" ON public.asset_restoration USING btree ("destinationId");

CREATE INDEX "asset_restoration_fullOperationId_idx" ON public.asset_restoration USING btree ("fullOperationId");

CREATE INDEX "asset_restoration_ownerId_createdAt_idx" ON public.asset_restoration USING btree ("ownerId", "createdAt");

CREATE INDEX "asset_restoration_ownerId_idx" ON public.asset_restoration USING btree ("ownerId");

CREATE INDEX "asset_restoration_previewOperationId_idx" ON public.asset_restoration USING btree ("previewOperationId");

CREATE INDEX "asset_restoration_resultExpiresAt_idx" ON public.asset_restoration USING btree ("resultExpiresAt");

CREATE INDEX "asset_restoration_status_previewExpiresAt_idx" ON public.asset_restoration USING btree (status, "previewExpiresAt");

CREATE INDEX "asset_stackId_idx" ON public.asset USING btree ("stackId");

CREATE INDEX "asset_updateId_idx" ON public.asset USING btree ("updateId");

CREATE INDEX "asset_upload_part_resourceId_idx" ON public.asset_upload_part USING btree ("resourceId");

CREATE UNIQUE INDEX "asset_upload_part_resourceId_offset_idx" ON public.asset_upload_part USING btree ("resourceId", "offset");

CREATE INDEX "asset_upload_resource_expiresAt_idx" ON public.asset_upload_resource USING btree ("expiresAt");

CREATE INDEX "asset_upload_resource_ownerId_idx" ON public.asset_upload_resource USING btree ("ownerId");

CREATE INDEX asset_user_share_owner_idx ON public.asset_user_share USING btree ("ownerId", "assetId");

CREATE INDEX asset_user_share_recipient_idx ON public.asset_user_share USING btree ("sharedWithId", "createdAt");

CREATE INDEX "asset_video_duplicate_frame_assetId_idx" ON public.asset_video_duplicate_frame USING btree ("assetId");

CREATE INDEX "backup_device_ownerId_idx" ON public.backup_device USING btree ("ownerId");

CREATE INDEX "backup_reconciliation_deviceId_idx" ON public.backup_reconciliation USING btree ("deviceId");

CREATE INDEX "backup_reconciliation_ownerId_idx" ON public.backup_reconciliation USING btree ("ownerId");

CREATE INDEX buddy_backup_reference_path_idx ON public.buddy_backup_reference USING btree (path);

CREATE INDEX "classification_match_assetId_idx" ON public.classification_match USING btree ("assetId");

CREATE INDEX "classification_match_ruleId_decision_idx" ON public.classification_match USING btree ("ruleId", decision);

CREATE INDEX "classification_match_ruleId_idx" ON public.classification_match USING btree ("ruleId");

CREATE INDEX "classification_rule_albumId_idx" ON public.classification_rule USING btree ("albumId");

CREATE INDEX "classification_rule_ownerId_idx" ON public.classification_rule USING btree ("ownerId");

CREATE INDEX "classification_rule_tagId_idx" ON public.classification_rule USING btree ("tagId");

CREATE INDEX clip_description_index ON public.smart_search_description USING hnsw (embedding public.vector_cosine_ops) WITH (ef_construction='300', m='16');

CREATE INDEX clip_index ON public.smart_search USING hnsw (embedding public.vector_cosine_ops) WITH (ef_construction='300', m='16');

CREATE INDEX "cloud_backup_manifest_original_manifestId_idx" ON public.cloud_backup_manifest_original USING btree ("manifestId");

CREATE INDEX "cloud_backup_object_verification_operationId_idx" ON public.cloud_backup_object_verification USING btree ("operationId");

CREATE INDEX "cluster_group_request_clusterGroupId_idx" ON public.cluster_group_request USING btree ("clusterGroupId");

CREATE INDEX "cluster_group_request_userId_idx" ON public.cluster_group_request USING btree ("userId");

CREATE INDEX "cluster_group_updateId_idx" ON public.cluster_group USING btree ("updateId");

CREATE INDEX "develop_export_assetId_idx" ON public.develop_export USING btree ("assetId");

CREATE INDEX "develop_export_ownerId_idx" ON public.develop_export USING btree ("ownerId");

CREATE INDEX "develop_preset_ownerId_idx" ON public.develop_preset USING btree ("ownerId");

CREATE INDEX "duplicate_decision_operationId_idx" ON public.duplicate_decision USING btree ("operationId");

CREATE INDEX "duplicate_decision_ownerId_createdAt_idx" ON public.duplicate_decision USING btree ("ownerId", "createdAt");

CREATE INDEX "duplicate_decision_ownerId_duplicateId_idx" ON public.duplicate_decision USING btree ("ownerId", "duplicateId");

CREATE INDEX "duplicate_decision_ownerId_idx" ON public.duplicate_decision USING btree ("ownerId");

CREATE INDEX "duplicate_decision_undoOperationId_idx" ON public.duplicate_decision USING btree ("undoOperationId");

CREATE INDEX face_correction_asset_idx ON public.face_correction USING btree ("assetId");

CREATE INDEX face_correction_face_idx ON public.face_correction USING btree ("faceId");

CREATE INDEX face_correction_owner_from_idx ON public.face_correction USING btree ("ownerId", "fromPersonId", "createdAt" DESC);

CREATE INDEX face_correction_owner_to_idx ON public.face_correction USING btree ("ownerId", "toPersonId", "createdAt" DESC);

CREATE INDEX face_index ON public.face_search USING hnsw (embedding public.vector_cosine_ops) WITH (ef_construction='300', m='16');

CREATE INDEX frameleaf_consent_destination_accepted_idx ON public.frameleaf_consent USING btree ("destinationId", "acceptedAt" DESC);

CREATE INDEX frameleaf_exchange_token_expires_idx ON public.frameleaf_exchange_token USING btree ("expiresAt");

CREATE INDEX frameleaf_rate_limit_expiry ON public.frameleaf_rate_limit USING btree (expires_at);

CREATE INDEX frameleaf_session_sid_idx ON public.frameleaf_session USING btree (sid);

CREATE INDEX frameleaf_session_sub_idx ON public.frameleaf_session USING btree (sub);

CREATE INDEX frameleaf_sign_in_revocation_expires_idx ON public.frameleaf_sign_in_revocation USING btree ("expiresAt");

CREATE INDEX frameleaf_upload_lease_expiry ON public.frameleaf_upload_lease USING btree (expires_at);

CREATE INDEX frameleaf_websocket_worker_expiry ON public.frameleaf_websocket_worker USING btree (expires_at);

CREATE INDEX icloud_album_mapping_idx ON public.icloud_album USING btree ("albumId") WHERE ("albumId" IS NOT NULL);

CREATE INDEX icloud_album_parent_idx ON public.icloud_album USING btree ("connectionId", "libraryKey", "parentSourceId");

CREATE INDEX icloud_connection_due_idx ON public.icloud_connection USING btree ("nextRunAt") WHERE ("nextRunAt" IS NOT NULL);

CREATE INDEX icloud_connection_owner_idx ON public.icloud_connection USING btree ("ownerId");

CREATE INDEX icloud_identity_audit_operation_idx ON public.icloud_identity_audit USING btree ("operationId");

CREATE INDEX icloud_identity_reuse_owner_connection_idx ON public.icloud_identity_reuse USING btree ("ownerId", "connectionId");

CREATE INDEX icloud_membership_asset_idx ON public.icloud_membership USING btree ("connectionId", "libraryKey", "sourceAssetId");

CREATE INDEX icloud_membership_snapshot_idx ON public.icloud_membership USING btree ("connectionId", "libraryKey", "sourceAlbumId", "snapshotId") WHERE "sourcePresent";

CREATE INDEX icloud_record_asset_name_idx ON public.icloud_record USING btree ("connectionId", upper("recordId")) WHERE (("recordType" = 'CPLAsset'::text) AND (NOT deleted));

CREATE INDEX icloud_record_master_idx ON public.icloud_record USING btree ("connectionId", "libraryKey", "masterId") WHERE ("masterId" IS NOT NULL);

CREATE INDEX icloud_record_type_idx ON public.icloud_record USING btree ("connectionId", "libraryKey", "recordType", "recordId") WHERE (NOT deleted);

CREATE INDEX icloud_resource_asset_idx ON public.icloud_resource USING btree ("assetId") WHERE ("assetId" IS NOT NULL);

CREATE UNIQUE INDEX icloud_resource_audit_request_key ON public.icloud_resource USING btree ("auditRequestId") WHERE ("auditRequestId" IS NOT NULL);

CREATE INDEX icloud_resource_jobs_idx ON public.icloud_resource USING btree ("connectionId", id) WHERE ("pendingJobs" <> '[]'::jsonb);

CREATE INDEX icloud_resource_lease_idx ON public.icloud_resource USING btree ("leaseExpiresAt") WHERE ("leaseToken" IS NOT NULL);

CREATE UNIQUE INDEX icloud_resource_ordinary_identity_key ON public.icloud_resource USING btree ("connectionId", "libraryKey", "sourceAssetId", "resourceKey", fingerprint) WHERE ("auditRequestId" IS NULL);

CREATE INDEX icloud_resource_owner_idx ON public.icloud_resource USING btree ("ownerId", status);

CREATE INDEX icloud_resource_pending_idx ON public.icloud_resource USING btree ("connectionId", status, "nextAttemptAt", id) WHERE (status = ANY (ARRAY['pending'::text, 'retry'::text]));

CREATE INDEX icloud_run_connection_started_idx ON public.icloud_run USING btree ("connectionId", "startedAt" DESC);

CREATE INDEX icloud_source_identity_asset_idx ON public.icloud_source_identity USING btree ("assetId");

CREATE INDEX icloud_source_identity_sha256_idx ON public.icloud_source_identity USING btree ("ownerId", sha256);

CREATE INDEX idx_asset_exif_description_trigram ON public.asset_exif USING gin (public.f_unaccent(description) public.gin_trgm_ops);

CREATE INDEX idx_asset_is_nsfw ON public.asset USING btree (is_nsfw) WHERE (is_nsfw = true);

CREATE INDEX idx_geodata_places_admin1_name ON public.geodata_places USING gin (public.f_unaccent(("admin1Name")::text) public.gin_trgm_ops);

CREATE INDEX idx_geodata_places_admin2_name ON public.geodata_places USING gin (public.f_unaccent(("admin2Name")::text) public.gin_trgm_ops);

CREATE INDEX idx_geodata_places_alternate_names ON public.geodata_places USING gin (public.f_unaccent(("alternateNames")::text) public.gin_trgm_ops);

CREATE INDEX idx_geodata_places_name ON public.geodata_places USING gin (public.f_unaccent((name)::text) public.gin_trgm_ops);

CREATE INDEX idx_ocr_search_text ON public.ocr_search USING gin (public.f_unaccent(text) public.gin_trgm_ops);

CREATE INDEX idx_person_name_trigram ON public.person USING gin (public.f_unaccent((name)::text) public.gin_trgm_ops);

CREATE INDEX "integrity_report_assetId_idx" ON public.integrity_report USING btree ("assetId");

CREATE INDEX "integrity_report_fileAssetId_idx" ON public.integrity_report USING btree ("fileAssetId");

CREATE INDEX job_claim ON public.job USING btree (queue, "availableAt", "createdAt") WHERE (state = ANY (ARRAY['pending'::text, 'waiting'::text]));

CREATE UNIQUE INDEX job_dedup_live ON public.job USING btree (queue, "dedupKey") WHERE (("dedupKey" IS NOT NULL) AND (state = ANY (ARRAY['pending'::text, 'waiting'::text, 'active'::text])));

CREATE INDEX job_lease ON public.job USING btree ("leaseExpiresAt") WHERE (state = 'active'::text);

CREATE INDEX job_manifest_pending ON public.job_run_item USING btree ("selectionId", "itemKey") WHERE (("jobId" IS NULL) AND (state = 'pending'::text));

CREATE INDEX job_parent ON public.job USING btree ("parentId") WHERE ("parentId" IS NOT NULL);

CREATE INDEX job_retention ON public.job USING btree ("finishedAt", id) WHERE ((state = ANY (ARRAY['completed'::text, 'failed'::text, 'cancelled'::text, 'blocked'::text])) AND ("latestPending" IS NULL));

CREATE INDEX job_run_item_job ON public.job_run_item USING btree ("jobId") WHERE ("jobId" IS NOT NULL);

CREATE INDEX job_run_root_item ON public.job_run_item USING btree ("runId", "rootItemKey");

CREATE UNIQUE INDEX job_run_stage ON public.job USING btree ("runId", "itemKey", name) WHERE ("runId" IS NOT NULL);

CREATE INDEX "library_ownerId_idx" ON public.library USING btree ("ownerId");

CREATE INDEX "library_updateId_idx" ON public.library USING btree ("updateId");

CREATE INDEX "media_operation_assetId_idx" ON public.media_operation USING btree ("assetId");

CREATE INDEX "media_operation_checkpoint_operationId_chunkKey_idx" ON public.media_operation_checkpoint USING btree ("operationId", "chunkKey");

CREATE INDEX "media_operation_checkpoint_operationId_idx" ON public.media_operation_checkpoint USING btree ("operationId");

CREATE UNIQUE INDEX "media_operation_enrichment_plan_requestKey_uq" ON public.media_operation USING btree ("ownerId", ((snapshot ->> 'requestKey'::text))) WHERE (((kind)::text = 'enrichment_plan'::text) AND ((snapshot ->> 'requestKey'::text) IS NOT NULL));

CREATE INDEX media_operation_kind_status_idx ON public.media_operation USING btree (kind, status);

CREATE INDEX "media_operation_ownerId_createdAt_idx" ON public.media_operation USING btree ("ownerId", "createdAt");

CREATE INDEX "media_operation_ownerId_idx" ON public.media_operation USING btree ("ownerId");

CREATE INDEX "media_operation_resultAssetId_idx" ON public.media_operation USING btree ("resultAssetId");

CREATE UNIQUE INDEX "media_operation_retryOfId_active_uq" ON public.media_operation USING btree ("retryOfId") WHERE (("retryOfId" IS NOT NULL) AND ((status)::text <> ALL ((ARRAY['completed'::character varying, 'cancelled'::character varying, 'failed'::character varying])::text[])));

CREATE INDEX "media_operation_retryOfId_idx" ON public.media_operation USING btree ("retryOfId");

CREATE INDEX "media_operation_status_claimExpiresAt_idx" ON public.media_operation USING btree (status, "claimExpiresAt");

CREATE INDEX "memory_asset_assetId_idx" ON public.memory_asset USING btree ("assetId");

CREATE INDEX "memory_asset_audit_assetId_idx" ON public.memory_asset_audit USING btree ("assetId");

CREATE INDEX "memory_asset_audit_deletedAt_idx" ON public.memory_asset_audit USING btree ("deletedAt");

CREATE INDEX "memory_asset_audit_memoryId_idx" ON public.memory_asset_audit USING btree ("memoryId");

CREATE INDEX "memory_asset_memoriesId_idx" ON public.memory_asset USING btree ("memoriesId");

CREATE INDEX "memory_asset_updateId_idx" ON public.memory_asset USING btree ("updateId");

CREATE INDEX "memory_audit_deletedAt_idx" ON public.memory_audit USING btree ("deletedAt");

CREATE INDEX "memory_audit_memoryId_idx" ON public.memory_audit USING btree ("memoryId");

CREATE INDEX "memory_audit_userId_idx" ON public.memory_audit USING btree ("userId");

CREATE INDEX memory_curation_owner_idx ON public.memory_curation USING btree ("ownerId");

CREATE INDEX "memory_export_memoryId_idx" ON public.memory_export USING btree ("memoryId");

CREATE INDEX "memory_export_ownerId_createdAt_idx" ON public.memory_export USING btree ("ownerId", "createdAt");

CREATE INDEX "memory_export_ownerId_idx" ON public.memory_export USING btree ("ownerId");

CREATE INDEX memory_export_status_idx ON public.memory_export USING btree (status);

CREATE INDEX "memory_export_studioExportVersionId_idx" ON public.memory_export USING btree ("studioExportVersionId");

CREATE INDEX "memory_export_studioProjectId_idx" ON public.memory_export USING btree ("studioProjectId");

CREATE INDEX "memory_ownerId_idx" ON public.memory USING btree ("ownerId");

CREATE INDEX "memory_updateId_idx" ON public.memory USING btree ("updateId");

CREATE INDEX "ml_destination_consentAcknowledgedBy_idx" ON public.ml_destination USING btree ("consentAcknowledgedBy");

CREATE INDEX "ml_workload_accounting_cloudJobId_idx" ON public.ml_workload_accounting USING btree ("cloudJobId") WHERE ("cloudJobId" IS NOT NULL);

CREATE INDEX "ml_workload_accounting_destinationId_idx" ON public.ml_workload_accounting USING btree ("destinationId");

CREATE INDEX "ml_workload_accounting_destinationId_startedAt_idx" ON public.ml_workload_accounting USING btree ("destinationId", "startedAt");

CREATE INDEX "ml_workload_accounting_jobId_jobName_startedAt_idx" ON public.ml_workload_accounting USING btree ("jobId", "jobName", "startedAt" DESC) WHERE ("jobId" IS NOT NULL);

CREATE INDEX "ml_workload_route_destinationId_idx" ON public.ml_workload_route USING btree ("destinationId");

CREATE INDEX "notification_updateId_idx" ON public.notification USING btree ("updateId");

CREATE INDEX "notification_userId_idx" ON public.notification USING btree ("userId");

CREATE INDEX "operational_metric_sample_libraryId_idx" ON public.operational_metric_sample USING btree ("libraryId");

CREATE INDEX "operational_metric_sample_userId_idx" ON public.operational_metric_sample USING btree ("userId");

CREATE INDEX "partner_audit_deletedAt_idx" ON public.partner_audit USING btree ("deletedAt");

CREATE INDEX "partner_audit_sharedById_idx" ON public.partner_audit USING btree ("sharedById");

CREATE INDEX "partner_audit_sharedWithId_idx" ON public.partner_audit USING btree ("sharedWithId");

CREATE INDEX "partner_createId_idx" ON public.partner USING btree ("createId");

CREATE INDEX partner_person_link_person_idx ON public.partner_person_link USING btree ("ownerId", "personGroupId");

CREATE INDEX "partner_sharedWithId_idx" ON public.partner USING btree ("sharedWithId");

CREATE INDEX "partner_updateId_idx" ON public.partner USING btree ("updateId");

CREATE INDEX "person_audit_deletedAt_idx" ON public.person_audit USING btree ("deletedAt");

CREATE INDEX "person_audit_ownerId_idx" ON public.person_audit USING btree ("ownerId");

CREATE INDEX "person_audit_personGroupId_idx" ON public.person_audit USING btree ("personGroupId");

CREATE INDEX "person_faceAssetId_idx" ON public.person USING btree ("faceAssetId");

CREATE INDEX "person_group_audit_clusterGroupId_idx" ON public.person_group_audit USING btree ("clusterGroupId");

CREATE INDEX "person_group_audit_deletedAt_idx" ON public.person_group_audit USING btree ("deletedAt");

CREATE INDEX "person_group_audit_personGroupId_idx" ON public.person_group_audit USING btree ("personGroupId");

CREATE INDEX "person_group_clusterGroupId_idx" ON public.person_group USING btree ("clusterGroupId");

CREATE INDEX "person_group_createId_idx" ON public.person_group USING btree ("createId");

CREATE INDEX "person_group_updateId_idx" ON public.person_group USING btree ("updateId");

CREATE INDEX person_origin_partner_idx ON public.person_origin USING btree ("partnerSharedById", "ownerId");

CREATE INDEX person_origin_source_idx ON public.person_origin USING btree ("sourceOwnerId", "sourcePersonGroupId") WHERE following;

CREATE INDEX "person_personGroupId_idx" ON public.person USING btree ("personGroupId");

CREATE INDEX "person_updateId_idx" ON public.person USING btree ("updateId");

CREATE INDEX "pet_audit_deletedAt_idx" ON public.pet_audit USING btree ("deletedAt");

CREATE INDEX "pet_audit_ownerId_idx" ON public.pet_audit USING btree ("ownerId");

CREATE INDEX "pet_audit_petId_idx" ON public.pet_audit USING btree ("petId");

CREATE INDEX "pet_candidate_petId_idx" ON public.pet_candidate USING btree ("petId");

CREATE INDEX "pet_detection_assetId_idx" ON public.pet_detection USING btree ("assetId");

CREATE INDEX "pet_detection_modelName_modelRevision_idx" ON public.pet_detection USING btree ("modelName", "modelRevision");

CREATE INDEX "pet_featuredAssetId_idx" ON public.pet USING btree ("featuredAssetId");

CREATE INDEX "pet_observation_assetId_idx" ON public.pet_observation USING btree ("assetId");

CREATE INDEX "pet_observation_audit_assetId_idx" ON public.pet_observation_audit USING btree ("assetId");

CREATE INDEX "pet_observation_audit_deletedAt_idx" ON public.pet_observation_audit USING btree ("deletedAt");

CREATE INDEX "pet_observation_audit_observationId_idx" ON public.pet_observation_audit USING btree ("observationId");

CREATE INDEX "pet_observation_audit_ownerId_idx" ON public.pet_observation_audit USING btree ("ownerId");

CREATE INDEX "pet_observation_audit_petId_idx" ON public.pet_observation_audit USING btree ("petId");

CREATE INDEX "pet_observation_updateId_idx" ON public.pet_observation USING btree ("updateId");

CREATE INDEX "pet_ownerId_idx" ON public.pet USING btree ("ownerId");

CREATE INDEX "pet_ownerId_isHidden_idx" ON public.pet USING btree ("ownerId", "isHidden");

CREATE INDEX "pet_updateId_idx" ON public.pet USING btree ("updateId");

CREATE INDEX photography_workflow_owner_idx ON public.photography_workflow USING btree ("ownerId");

CREATE INDEX "physical_file_canonicalAssetId_idx" ON public.physical_file USING btree ("canonicalAssetId");

CREATE INDEX "physical_file_canonicalAssetId_type_idx" ON public.physical_file USING btree ("canonicalAssetId", type);

CREATE INDEX "physical_file_checksum_sizeInBytes_type_idx" ON public.physical_file USING btree (checksum, "sizeInBytes", type);

CREATE INDEX physical_file_trash_checksum_idx ON public.physical_file_trash USING btree (checksum, "sizeInBytes");

CREATE INDEX physical_file_trash_trashed_at_idx ON public.physical_file_trash USING btree ("trashedAt");

CREATE INDEX "physical_file_updateId_idx" ON public.physical_file USING btree ("updateId");

CREATE INDEX "plugin_method_pluginId_idx" ON public.plugin_method USING btree ("pluginId");

CREATE INDEX plugin_name_idx ON public.plugin USING btree (name);

CREATE INDEX "preservation_item_assetId_idx" ON public.preservation_item USING btree ("assetId");

CREATE INDEX "preservation_item_packageId_state_idx" ON public.preservation_item USING btree ("packageId", state);

CREATE INDEX "preservation_package_ownerId_createdAt_idx" ON public.preservation_package USING btree ("ownerId", "createdAt");

CREATE INDEX "preservation_package_ownerId_idx" ON public.preservation_package USING btree ("ownerId");

CREATE INDEX "preservation_restore_item_assetId_idx" ON public.preservation_restore_item USING btree ("assetId");

CREATE INDEX "preservation_restore_item_restoreId_state_idx" ON public.preservation_restore_item USING btree ("restoreId", state);

CREATE INDEX "preservation_restore_ownerId_createdAt_idx" ON public.preservation_restore USING btree ("ownerId", "createdAt");

CREATE INDEX "preservation_restore_ownerId_idx" ON public.preservation_restore USING btree ("ownerId");

CREATE INDEX "preservation_restore_packageId_idx" ON public.preservation_restore USING btree ("packageId");

CREATE INDEX "push_device_activity_deviceId_idx" ON public.push_device_activity USING btree ("deviceId");

CREATE INDEX "push_device_sessionId_idx" ON public.push_device USING btree ("sessionId");

CREATE INDEX "push_device_userId_idx" ON public.push_device USING btree ("userId");

CREATE INDEX recipient_group_owner_idx ON public.recipient_group USING btree ("ownerId");

CREATE INDEX "render_worker_audit_operationId_idx" ON public.render_worker_audit USING btree ("operationId");

CREATE INDEX "render_worker_audit_workerId_createdAt_idx" ON public.render_worker_audit USING btree ("workerId", "createdAt");

CREATE INDEX "render_worker_createdBy_idx" ON public.render_worker USING btree ("createdBy");

CREATE INDEX "render_worker_enrolmentSecret_idx" ON public.render_worker USING btree ("enrolmentSecret");

CREATE INDEX "render_worker_limit_userId_idx" ON public.render_worker_limit USING btree ("userId");

CREATE INDEX render_worker_session_token_idx ON public.render_worker_session USING btree (token);

CREATE INDEX "render_worker_session_workerId_expiresAt_idx" ON public.render_worker_session USING btree ("workerId", "expiresAt");

CREATE INDEX "render_worker_session_workerId_idx" ON public.render_worker_session USING btree ("workerId");

CREATE INDEX render_worker_status_destination_idx ON public.render_worker USING btree (status, destination);

CREATE INDEX "session_oauthSid_idx" ON public.session USING btree ("oauthSid");

CREATE INDEX "session_parentId_idx" ON public.session USING btree ("parentId");

CREATE INDEX "session_sync_checkpoint_sessionId_idx" ON public.session_sync_checkpoint USING btree ("sessionId");

CREATE INDEX "session_sync_checkpoint_updateId_idx" ON public.session_sync_checkpoint USING btree ("updateId");

CREATE INDEX "session_tag_sync_state_eventId_idx" ON public.session_tag_sync_state USING btree ("eventId");

CREATE INDEX session_token_idx ON public.session USING btree (token);

CREATE INDEX "session_updateId_idx" ON public.session USING btree ("updateId");

CREATE INDEX "session_userId_idx" ON public.session USING btree ("userId");

CREATE INDEX "shared_link_albumId_idx" ON public.shared_link USING btree ("albumId");

CREATE INDEX "shared_link_asset_assetId_idx" ON public.shared_link_asset USING btree ("assetId");

CREATE INDEX "shared_link_asset_sharedLinkId_idx" ON public.shared_link_asset USING btree ("sharedLinkId");

CREATE INDEX shared_link_key_idx ON public.shared_link USING btree (key);

CREATE INDEX "shared_link_userId_idx" ON public.shared_link USING btree ("userId");

CREATE INDEX "shared_space_album_albumId_idx" ON public.shared_space_album USING btree ("albumId");

CREATE INDEX "shared_space_album_linkedAlbumId_idx" ON public.shared_space_album USING btree ("linkedAlbumId");

CREATE INDEX "shared_space_album_linkedById_idx" ON public.shared_space_album USING btree ("linkedById");

CREATE INDEX "shared_space_comment_thread_albumId_idx" ON public.shared_space_comment_thread USING btree ("albumId");

CREATE INDEX "shared_space_comment_thread_parentActivityId_idx" ON public.shared_space_comment_thread USING btree ("parentActivityId");

CREATE INDEX "shared_space_event_activityId_idx" ON public.shared_space_event USING btree ("activityId");

CREATE INDEX "shared_space_event_actorId_idx" ON public.shared_space_event USING btree ("actorId");

CREATE INDEX "shared_space_event_albumId_createdAt_idx" ON public.shared_space_event USING btree ("albumId", "createdAt");

CREATE INDEX "shared_space_event_albumId_idx" ON public.shared_space_event USING btree ("albumId");

CREATE INDEX "shared_space_event_targetUserId_idx" ON public.shared_space_event USING btree ("targetUserId");

CREATE INDEX "shared_space_invite_albumId_idx" ON public.shared_space_invite USING btree ("albumId");

CREATE INDEX "shared_space_invite_invitedById_idx" ON public.shared_space_invite USING btree ("invitedById");

CREATE INDEX "shared_space_invite_userId_idx" ON public.shared_space_invite USING btree ("userId");

CREATE INDEX "shared_space_mention_activityId_idx" ON public.shared_space_mention USING btree ("activityId");

CREATE INDEX "shared_space_mention_userId_idx" ON public.shared_space_mention USING btree ("userId");

CREATE INDEX "shared_space_person_albumId_idx" ON public.shared_space_person USING btree ("albumId");

CREATE INDEX "shared_space_person_coverAssetId_idx" ON public.shared_space_person USING btree ("coverAssetId");

CREATE INDEX "shared_space_person_personGroupId_idx" ON public.shared_space_person USING btree ("personGroupId");

CREATE INDEX "shared_space_person_personOwnerId_idx" ON public.shared_space_person USING btree ("personOwnerId");

CREATE INDEX "shared_space_visit_albumId_idx" ON public.shared_space_visit USING btree ("albumId");

CREATE INDEX "shared_space_visit_userId_idx" ON public.shared_space_visit USING btree ("userId");

CREATE INDEX "smart_album_albumId_idx" ON public.smart_album USING btree ("albumId");

CREATE INDEX "smart_album_asset_assetId_idx" ON public.smart_album_asset USING btree ("assetId");

CREATE INDEX "smart_album_asset_smartAlbumId_idx" ON public.smart_album_asset USING btree ("smartAlbumId");

CREATE INDEX "smart_album_exclusion_assetId_idx" ON public.smart_album_exclusion USING btree ("assetId");

CREATE INDEX "smart_album_exclusion_smartAlbumId_idx" ON public.smart_album_exclusion USING btree ("smartAlbumId");

CREATE INDEX "smart_album_ownerId_idx" ON public.smart_album USING btree ("ownerId");

CREATE INDEX socket_io_attachments_expiry ON public.socket_io_attachments USING btree (created_at);

CREATE INDEX "stack_audit_deletedAt_idx" ON public.stack_audit USING btree ("deletedAt");

CREATE INDEX "stack_ownerId_idx" ON public.stack USING btree ("ownerId");

CREATE INDEX "stack_primaryAssetId_idx" ON public.stack USING btree ("primaryAssetId");

CREATE INDEX "studio_bundle_upload_ownerId_expiresAt_idx" ON public.studio_bundle_upload USING btree ("ownerId", "expiresAt");

CREATE INDEX "studio_bundle_upload_ownerId_idx" ON public.studio_bundle_upload USING btree ("ownerId");

CREATE INDEX "studio_export_remote_reference_versionId_idx" ON public.studio_export_remote_reference USING btree ("versionId");

CREATE INDEX "studio_export_remote_reference_workerId_acknowledgedAt_idx" ON public.studio_export_remote_reference USING btree ("workerId", "acknowledgedAt");

CREATE INDEX "studio_export_version_ownerId_idx" ON public.studio_export_version USING btree ("ownerId");

CREATE INDEX "studio_export_version_projectId_createdAt_idx" ON public.studio_export_version USING btree ("projectId", "createdAt");

CREATE INDEX "studio_export_version_projectId_idx" ON public.studio_export_version USING btree ("projectId");

CREATE INDEX "studio_export_version_publishOperationId_idx" ON public.studio_export_version USING btree ("publishOperationId");

CREATE INDEX "studio_export_version_renderOperationId_idx" ON public.studio_export_version USING btree ("renderOperationId");

CREATE INDEX "studio_export_version_resultAssetId_idx" ON public.studio_export_version USING btree ("resultAssetId");

CREATE INDEX "studio_export_version_source_assetId_idx" ON public.studio_export_version_source USING btree ("assetId");

CREATE INDEX "studio_export_version_source_versionId_idx" ON public.studio_export_version_source USING btree ("versionId");

CREATE INDEX "studio_export_version_state_updatedAt_idx" ON public.studio_export_version USING btree (state, "updatedAt");

CREATE INDEX "studio_preview_frame_operationId_idx" ON public.studio_preview_frame USING btree ("operationId");

CREATE INDEX "studio_preview_frame_ownerId_idx" ON public.studio_preview_frame USING btree ("ownerId");

CREATE INDEX "studio_preview_frame_ownerId_projectId_revisionDigest_idx" ON public.studio_preview_frame USING btree ("ownerId", "projectId", "revisionDigest");

CREATE INDEX "studio_preview_frame_projectId_requestedAt_idx" ON public.studio_preview_frame USING btree ("projectId", "requestedAt");

CREATE INDEX "studio_preview_frame_status_expiresAt_idx" ON public.studio_preview_frame USING btree (status, "expiresAt");

CREATE INDEX "studio_project_comment_authorId_idx" ON public.studio_project_comment USING btree ("authorId");

CREATE INDEX "studio_project_comment_projectId_createdAt_idx" ON public.studio_project_comment USING btree ("projectId", "createdAt");

CREATE INDEX "studio_project_comment_projectId_idx" ON public.studio_project_comment USING btree ("projectId");

CREATE INDEX "studio_project_comment_resolvedById_idx" ON public.studio_project_comment USING btree ("resolvedById");

CREATE INDEX "studio_project_duplicatedFromId_idx" ON public.studio_project USING btree ("duplicatedFromId");

CREATE INDEX "studio_project_leaseHolderId_idx" ON public.studio_project USING btree ("leaseHolderId");

CREATE INDEX "studio_project_ownerId_idx" ON public.studio_project USING btree ("ownerId");

CREATE INDEX "studio_project_ownerId_updatedAt_idx" ON public.studio_project USING btree ("ownerId", "updatedAt");

CREATE INDEX "studio_project_purgeAfter_idx" ON public.studio_project USING btree ("purgeAfter");

CREATE INDEX "studio_project_revision_authorId_idx" ON public.studio_project_revision USING btree ("authorId");

CREATE INDEX "studio_project_revision_projectId_idx" ON public.studio_project_revision USING btree ("projectId");

CREATE INDEX "studio_project_spaceId_idx" ON public.studio_project USING btree ("spaceId");

CREATE INDEX "studio_project_thumbnailAssetId_idx" ON public.studio_project USING btree ("thumbnailAssetId");

CREATE INDEX "tag_asset_assetId_idx" ON public.tag_asset USING btree ("assetId");

CREATE INDEX "tag_asset_assetId_tagId_idx" ON public.tag_asset USING btree ("assetId", "tagId");

CREATE INDEX "tag_asset_audit_assetId_idx" ON public.tag_asset_audit USING btree ("assetId");

CREATE INDEX "tag_asset_audit_deletedAt_idx" ON public.tag_asset_audit USING btree ("deletedAt");

CREATE INDEX "tag_asset_audit_tagId_idx" ON public.tag_asset_audit USING btree ("tagId");

CREATE INDEX "tag_asset_audit_userId_idx" ON public.tag_asset_audit USING btree ("userId");

CREATE INDEX "tag_asset_tagId_idx" ON public.tag_asset USING btree ("tagId");

CREATE INDEX "tag_asset_updateId_idx" ON public.tag_asset USING btree ("updateId");

CREATE INDEX "tag_audit_deletedAt_idx" ON public.tag_audit USING btree ("deletedAt");

CREATE INDEX "tag_audit_tagId_idx" ON public.tag_audit USING btree ("tagId");

CREATE INDEX "tag_audit_userId_idx" ON public.tag_audit USING btree ("userId");

CREATE INDEX tag_closure_id_ancestor_idx ON public.tag_closure USING btree (id_ancestor);

CREATE INDEX tag_closure_id_descendant_idx ON public.tag_closure USING btree (id_descendant);

CREATE INDEX "tag_parentId_idx" ON public.tag USING btree ("parentId");

CREATE INDEX "tag_updateId_idx" ON public.tag USING btree ("updateId");

CREATE INDEX "takeout_album_albumId_idx" ON public.takeout_album USING btree ("albumId");

CREATE INDEX "takeout_album_ownerId_idx" ON public.takeout_album USING btree ("ownerId");

CREATE INDEX "takeout_file_importId_folder_idx" ON public.takeout_file USING btree ("importId", folder);

CREATE INDEX "takeout_file_importId_idx" ON public.takeout_file USING btree ("importId");

CREATE INDEX "takeout_file_sourceId_idx" ON public.takeout_file USING btree ("sourceId");

CREATE INDEX "takeout_import_ownerId_createdAt_idx" ON public.takeout_import USING btree ("ownerId", "createdAt");

CREATE INDEX "takeout_import_ownerId_idx" ON public.takeout_import USING btree ("ownerId");

CREATE INDEX "takeout_import_runOperationId_idx" ON public.takeout_import USING btree ("runOperationId");

CREATE INDEX "takeout_item_assetId_idx" ON public.takeout_item USING btree ("assetId");

CREATE INDEX "takeout_item_importId_state_idx" ON public.takeout_item USING btree ("importId", state);

CREATE INDEX "takeout_pair_importId_state_idx" ON public.takeout_pair USING btree ("importId", state);

CREATE INDEX "takeout_pair_photoItemId_idx" ON public.takeout_pair USING btree ("photoItemId");

CREATE INDEX "takeout_pair_videoItemId_idx" ON public.takeout_pair USING btree ("videoItemId");

CREATE INDEX "takeout_source_importId_idx" ON public.takeout_source USING btree ("importId");

CREATE INDEX "user_audit_deletedAt_idx" ON public.user_audit USING btree ("deletedAt");

CREATE INDEX "user_clusterGroupId_idx" ON public."user" USING btree ("clusterGroupId");

CREATE INDEX user_preference_history_user_created_idx ON public.user_preference_history USING btree ("userId", "createdAt" DESC);

CREATE INDEX "user_profileImageAssetId_idx" ON public."user" USING btree ("profileImageAssetId");

CREATE INDEX "user_updateId_idx" ON public."user" USING btree ("updateId");

CREATE INDEX "user_updatedAt_id_idx" ON public."user" USING btree ("updatedAt", id);

CREATE INDEX utility_activity_user_tool_created_idx ON public.utility_activity USING btree ("userId", tool, "createdAt" DESC);

CREATE INDEX video_edit_version_asset_idx ON public.video_edit_version USING btree ("assetId", "createdAt" DESC);

CREATE INDEX "video_moment_assetId_idx" ON public.video_moment USING btree ("assetId");

CREATE INDEX "video_moment_assetId_timestampMs_idx" ON public.video_moment USING btree ("assetId", "timestampMs");

CREATE INDEX "video_moment_createdById_idx" ON public.video_moment USING btree ("createdById");

CREATE INDEX "video_moment_frameId_idx" ON public.video_moment USING btree ("frameId");

CREATE INDEX "video_moment_frame_assetId_idx" ON public.video_moment_frame USING btree ("assetId");

CREATE INDEX video_moment_frame_index ON public.video_moment_frame_embedding USING hnsw (embedding public.vector_cosine_ops) WITH (ef_construction='300', m='16');

CREATE INDEX "video_moment_index_coverSetById_idx" ON public.video_moment_index USING btree ("coverSetById");

CREATE INDEX "video_stream_session_assetId_idx" ON public.video_stream_session USING btree ("assetId");

CREATE INDEX "video_stream_session_expiresAt_idx" ON public.video_stream_session USING btree ("expiresAt");

CREATE UNIQUE INDEX "video_stream_variant_sessionId_bitrate_resolution_codec_idx" ON public.video_stream_variant USING btree ("sessionId", bitrate, resolution, codec);

CREATE INDEX "workflow_log_detail_workflowId_idx" ON public.workflow_log_detail USING btree ("workflowId");

CREATE INDEX "workflow_ownerId_idx" ON public.workflow USING btree ("ownerId");

CREATE INDEX "workflow_run_step_createdAt_idx" ON public.workflow_run_step USING btree ("createdAt");

CREATE INDEX "workflow_run_step_workflowId_idx" ON public.workflow_run_step USING btree ("workflowId");

CREATE INDEX "workflow_step_pluginMethodId_idx" ON public.workflow_step USING btree ("pluginMethodId");

CREATE INDEX "workflow_step_workflowId_idx" ON public.workflow_step USING btree ("workflowId");

CREATE TRIGGER "activity_updatedAt" BEFORE UPDATE ON public.activity FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER album_asset_delete_audit AFTER DELETE ON public.album_asset REFERENCING OLD TABLE AS old FOR EACH STATEMENT WHEN ((pg_trigger_depth() <= 1)) EXECUTE FUNCTION public.album_asset_delete_audit();

CREATE TRIGGER "album_asset_updatedAt" BEFORE UPDATE ON public.album_asset FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER album_parent_cycle_check_trigger BEFORE INSERT OR UPDATE ON public.album FOR EACH ROW EXECUTE FUNCTION public.album_parent_cycle_check();

CREATE TRIGGER "album_updatedAt" BEFORE UPDATE ON public.album FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER album_user_after_insert AFTER INSERT ON public.album_user REFERENCING NEW TABLE AS inserted_rows FOR EACH STATEMENT EXECUTE FUNCTION public.album_user_after_insert();

CREATE TRIGGER album_user_delete AFTER DELETE ON public.album_user REFERENCING OLD TABLE AS old FOR EACH ROW EXECUTE FUNCTION public.album_user_delete();

CREATE TRIGGER album_user_delete_audit AFTER DELETE ON public.album_user REFERENCING OLD TABLE AS old FOR EACH STATEMENT WHEN ((pg_trigger_depth() <= 1)) EXECUTE FUNCTION public.album_user_delete_audit();

CREATE TRIGGER "album_user_updatedAt" BEFORE UPDATE ON public.album_user FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER "api_key_updatedAt" BEFORE UPDATE ON public.api_key FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER asset_backup_deletion_capture_trigger BEFORE DELETE ON public.asset FOR EACH ROW EXECUTE FUNCTION public.asset_backup_deletion_capture();

CREATE TRIGGER asset_delete_audit AFTER DELETE ON public.asset REFERENCING OLD TABLE AS old FOR EACH STATEMENT WHEN ((pg_trigger_depth() = 0)) EXECUTE FUNCTION public.asset_delete_audit();

CREATE TRIGGER asset_edit_audit AFTER DELETE ON public.asset_edit REFERENCING OLD TABLE AS old FOR EACH STATEMENT WHEN ((pg_trigger_depth() = 0)) EXECUTE FUNCTION public.asset_edit_audit();

CREATE TRIGGER asset_edit_delete AFTER DELETE ON public.asset_edit REFERENCING OLD TABLE AS deleted_edit FOR EACH STATEMENT WHEN ((pg_trigger_depth() = 0)) EXECUTE FUNCTION public.asset_edit_delete();

CREATE TRIGGER asset_edit_insert AFTER INSERT ON public.asset_edit REFERENCING NEW TABLE AS inserted_edit FOR EACH STATEMENT EXECUTE FUNCTION public.asset_edit_insert();

CREATE TRIGGER "asset_edit_updatedAt" BEFORE UPDATE ON public.asset_edit FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER "asset_exif_updatedAt" BEFORE UPDATE ON public.asset_exif FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER asset_face_audit AFTER DELETE ON public.asset_face REFERENCING OLD TABLE AS old FOR EACH STATEMENT WHEN ((pg_trigger_depth() = 0)) EXECUTE FUNCTION public.asset_face_audit();

CREATE TRIGGER "asset_face_updatedAt" BEFORE UPDATE ON public.asset_face FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER "asset_file_updatedAt" BEFORE UPDATE ON public.asset_file FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER "asset_health_candidate_updatedAt" BEFORE UPDATE ON public.asset_health_candidate FOR EACH ROW EXECUTE FUNCTION public.media_health_updated_at();

CREATE TRIGGER "asset_health_updatedAt" BEFORE UPDATE ON public.asset_health FOR EACH ROW EXECUTE FUNCTION public.media_health_updated_at();

CREATE TRIGGER asset_metadata_audit AFTER DELETE ON public.asset_metadata REFERENCING OLD TABLE AS old FOR EACH STATEMENT WHEN ((pg_trigger_depth() = 0)) EXECUTE FUNCTION public.asset_metadata_audit();

CREATE TRIGGER asset_metadata_updated_at BEFORE UPDATE ON public.asset_metadata FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER asset_ocr_delete_audit AFTER DELETE ON public.asset_ocr REFERENCING OLD TABLE AS old FOR EACH STATEMENT WHEN ((pg_trigger_depth() = 0)) EXECUTE FUNCTION public.asset_ocr_delete_audit();

CREATE TRIGGER "asset_ocr_updatedAt" BEFORE UPDATE ON public.asset_ocr FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER "asset_restoration_updatedAt" BEFORE UPDATE ON public.asset_restoration FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER "asset_updatedAt" BEFORE UPDATE ON public.asset FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER "asset_video_duplicate_frame_updatedAt" BEFORE UPDATE ON public.asset_video_duplicate_frame FOR EACH ROW EXECUTE FUNCTION public.media_health_updated_at();

CREATE TRIGGER "cluster_group_updatedAt" BEFORE UPDATE ON public.cluster_group FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER icloud_connection_unhealthy_since BEFORE INSERT OR UPDATE OF state ON public.icloud_connection FOR EACH ROW EXECUTE FUNCTION public.icloud_connection_unhealthy_since();

CREATE TRIGGER icloud_weekly_cohort_frozen BEFORE UPDATE ON public.icloud_weekly_cohort FOR EACH ROW EXECUTE FUNCTION public.freeze_icloud_weekly_bindings();

CREATE TRIGGER icloud_weekly_connection_retirement AFTER UPDATE ON public.icloud_connection FOR EACH ROW EXECUTE FUNCTION public.retire_icloud_weekly_authority();

CREATE TRIGGER icloud_weekly_member_frozen BEFORE UPDATE ON public.icloud_weekly_member FOR EACH ROW EXECUTE FUNCTION public.freeze_icloud_weekly_bindings();

CREATE TRIGGER icloud_weekly_pin_retirement AFTER DELETE OR UPDATE ON public."user" FOR EACH ROW EXECUTE FUNCTION public.retire_icloud_weekly_authority();

CREATE TRIGGER icloud_weekly_privacy_retirement AFTER INSERT OR DELETE OR UPDATE ON public.user_metadata FOR EACH ROW EXECUTE FUNCTION public.retire_icloud_weekly_authority();

CREATE TRIGGER "library_updatedAt" BEFORE UPDATE ON public.library FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER "media_operation_checkpoint_updatedAt" BEFORE UPDATE ON public.media_operation_checkpoint FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER "media_operation_updatedAt" BEFORE UPDATE ON public.media_operation FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER memory_asset_delete_audit AFTER DELETE ON public.memory_asset REFERENCING OLD TABLE AS old FOR EACH STATEMENT WHEN ((pg_trigger_depth() <= 1)) EXECUTE FUNCTION public.memory_asset_delete_audit();

CREATE TRIGGER "memory_asset_updatedAt" BEFORE UPDATE ON public.memory_asset FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER memory_delete_audit AFTER DELETE ON public.memory REFERENCING OLD TABLE AS old FOR EACH STATEMENT WHEN ((pg_trigger_depth() = 0)) EXECUTE FUNCTION public.memory_delete_audit();

CREATE TRIGGER "memory_updatedAt" BEFORE UPDATE ON public.memory FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER "notification_updatedAt" BEFORE UPDATE ON public.notification FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER partner_delete_audit AFTER DELETE ON public.partner REFERENCING OLD TABLE AS old FOR EACH STATEMENT WHEN ((pg_trigger_depth() = 0)) EXECUTE FUNCTION public.partner_delete_audit();

CREATE TRIGGER "partner_updatedAt" BEFORE UPDATE ON public.partner FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER person_delete_audit AFTER DELETE ON public.person REFERENCING OLD TABLE AS old FOR EACH STATEMENT WHEN ((pg_trigger_depth() <= 1)) EXECUTE FUNCTION public.person_delete_audit();

CREATE TRIGGER person_group_delete_audit AFTER DELETE ON public.person_group REFERENCING OLD TABLE AS old FOR EACH STATEMENT WHEN ((pg_trigger_depth() = 0)) EXECUTE FUNCTION public.person_group_delete_audit();

CREATE TRIGGER "person_group_updatedAt" BEFORE UPDATE ON public.person_group FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER "person_updatedAt" BEFORE UPDATE ON public.person FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER pet_delete_audit AFTER DELETE ON public.pet REFERENCING OLD TABLE AS old FOR EACH STATEMENT EXECUTE FUNCTION public.pet_delete_audit();

CREATE TRIGGER pet_observation_delete_audit AFTER DELETE ON public.pet_observation REFERENCING OLD TABLE AS old FOR EACH STATEMENT EXECUTE FUNCTION public.pet_observation_delete_audit();

CREATE TRIGGER pet_observation_update_id BEFORE UPDATE ON public.pet_observation FOR EACH ROW EXECUTE FUNCTION public.pet_observation_update_id();

CREATE TRIGGER pet_update_id BEFORE UPDATE ON public.pet FOR EACH ROW EXECUTE FUNCTION public.pet_update_id();

CREATE TRIGGER "physical_file_updatedAt" BEFORE UPDATE ON public.physical_file FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER "preservation_item_updatedAt" BEFORE UPDATE ON public.preservation_item FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER "preservation_package_updatedAt" BEFORE UPDATE ON public.preservation_package FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER "preservation_restore_item_updatedAt" BEFORE UPDATE ON public.preservation_restore_item FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER "preservation_restore_updatedAt" BEFORE UPDATE ON public.preservation_restore FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER "render_worker_limit_updatedAt" BEFORE UPDATE ON public.render_worker_limit FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER "render_worker_updatedAt" BEFORE UPDATE ON public.render_worker FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER "session_sync_checkpoint_updatedAt" BEFORE UPDATE ON public.session_sync_checkpoint FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER "session_updatedAt" BEFORE UPDATE ON public.session FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER stack_delete_audit AFTER DELETE ON public.stack REFERENCING OLD TABLE AS old FOR EACH STATEMENT WHEN ((pg_trigger_depth() = 0)) EXECUTE FUNCTION public.stack_delete_audit();

CREATE TRIGGER "stack_updatedAt" BEFORE UPDATE ON public.stack FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER "studio_preview_frame_updatedAt" BEFORE UPDATE ON public.studio_preview_frame FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER "studio_project_comment_updatedAt" BEFORE UPDATE ON public.studio_project_comment FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER "studio_project_updatedAt" BEFORE UPDATE ON public.studio_project FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER tag_asset_delete_audit AFTER DELETE ON public.tag_asset REFERENCING OLD TABLE AS old FOR EACH STATEMENT EXECUTE FUNCTION public.tag_asset_delete_audit();

CREATE TRIGGER tag_asset_update_id BEFORE UPDATE ON public.tag_asset FOR EACH ROW EXECUTE FUNCTION public.tag_asset_update_id();

CREATE TRIGGER tag_delete_audit AFTER DELETE ON public.tag REFERENCING OLD TABLE AS old FOR EACH STATEMENT EXECUTE FUNCTION public.tag_delete_audit();

CREATE TRIGGER "tag_updatedAt" BEFORE UPDATE ON public.tag FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER user_delete_audit AFTER DELETE ON public."user" REFERENCING OLD TABLE AS old FOR EACH STATEMENT WHEN ((pg_trigger_depth() = 0)) EXECUTE FUNCTION public.user_delete_audit();

CREATE TRIGGER user_metadata_audit AFTER DELETE ON public.user_metadata REFERENCING OLD TABLE AS old FOR EACH STATEMENT WHEN ((pg_trigger_depth() = 0)) EXECUTE FUNCTION public.user_metadata_audit();

CREATE TRIGGER user_metadata_updated_at BEFORE UPDATE ON public.user_metadata FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER "user_updatedAt" BEFORE UPDATE ON public."user" FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER "video_moment_frame_updatedAt" BEFORE UPDATE ON public.video_moment_frame FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER "video_moment_index_updatedAt" BEFORE UPDATE ON public.video_moment_index FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER "video_moment_updatedAt" BEFORE UPDATE ON public.video_moment FOR EACH ROW EXECUTE FUNCTION public.updated_at();

CREATE TRIGGER "workflow_updatedAt" BEFORE UPDATE ON public.workflow FOR EACH ROW EXECUTE FUNCTION public.updated_at();

ALTER TABLE ONLY public.activity
    ADD CONSTRAINT "activity_albumId_assetId_fkey" FOREIGN KEY ("albumId", "assetId") REFERENCES public.album_asset("albumId", "assetId") ON DELETE CASCADE;

ALTER TABLE ONLY public.activity
    ADD CONSTRAINT "activity_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES public.album(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.activity
    ADD CONSTRAINT "activity_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.activity
    ADD CONSTRAINT "activity_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.admin_audit_event
    ADD CONSTRAINT "admin_audit_event_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.admin_audit_event
    ADD CONSTRAINT "admin_audit_event_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES public.library(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.admin_audit_event
    ADD CONSTRAINT "admin_audit_event_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.album
    ADD CONSTRAINT "album_albumThumbnailAssetId_fkey" FOREIGN KEY ("albumThumbnailAssetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.album_asset
    ADD CONSTRAINT "album_asset_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES public.album(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.album_asset
    ADD CONSTRAINT "album_asset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.album_asset_audit
    ADD CONSTRAINT "album_asset_audit_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES public.album(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.album_closure
    ADD CONSTRAINT album_closure_id_ancestor_fkey FOREIGN KEY (id_ancestor) REFERENCES public.album(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.album_closure
    ADD CONSTRAINT album_closure_id_descendant_fkey FOREIGN KEY (id_descendant) REFERENCES public.album(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.album
    ADD CONSTRAINT "album_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES public.album(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.album_source_asset
    ADD CONSTRAINT album_source_asset_asset_fkey FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.album_source_asset
    ADD CONSTRAINT album_source_asset_link_fkey FOREIGN KEY ("linkId") REFERENCES public.album_source_link(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.album_source_link
    ADD CONSTRAINT album_source_link_album_fkey FOREIGN KEY ("albumId") REFERENCES public.album(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.album_source_link
    ADD CONSTRAINT album_source_link_user_fkey FOREIGN KEY ("userId") REFERENCES public."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.album_user
    ADD CONSTRAINT "album_user_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES public.album(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.album_user
    ADD CONSTRAINT "album_user_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.api_key
    ADD CONSTRAINT "api_key_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.archive_operation_item
    ADD CONSTRAINT "archive_operation_item_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES public.archive_operation(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.asset_best_photo_score
    ADD CONSTRAINT "asset_best_photo_score_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.asset_best_photo_score
    ADD CONSTRAINT "asset_best_photo_score_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.asset_document_edit
    ADD CONSTRAINT "asset_document_edit_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.asset_document_edit
    ADD CONSTRAINT "asset_document_edit_editedById_fkey" FOREIGN KEY ("editedById") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.asset_edit
    ADD CONSTRAINT "asset_edit_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.asset_exif
    ADD CONSTRAINT "asset_exif_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.asset_face
    ADD CONSTRAINT "asset_face_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.asset_face
    ADD CONSTRAINT "asset_face_personGroupId_fkey" FOREIGN KEY ("personGroupId") REFERENCES public.person_group(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.asset_file
    ADD CONSTRAINT "asset_file_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.asset_file
    ADD CONSTRAINT "asset_file_physicalFileId_fkey" FOREIGN KEY ("physicalFileId") REFERENCES public.physical_file(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.asset_health
    ADD CONSTRAINT "asset_health_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.asset_health_candidate
    ADD CONSTRAINT "asset_health_candidate_healthId_fkey" FOREIGN KEY ("healthId") REFERENCES public.asset_health(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.asset_health
    ADD CONSTRAINT "asset_health_runId_fkey" FOREIGN KEY ("runId") REFERENCES public.asset_health_run(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.asset_health_run
    ADD CONSTRAINT "asset_health_run_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.asset_integrity_verification
    ADD CONSTRAINT "asset_integrity_verification_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.asset_job_status
    ADD CONSTRAINT "asset_job_status_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.asset
    ADD CONSTRAINT "asset_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES public.library(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.asset
    ADD CONSTRAINT "asset_livePhotoVideoId_fkey" FOREIGN KEY ("livePhotoVideoId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.asset_lock
    ADD CONSTRAINT "asset_lock_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.asset_lock
    ADD CONSTRAINT "asset_lock_lockedBy_fkey" FOREIGN KEY ("lockedBy") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.asset_metadata
    ADD CONSTRAINT "asset_metadata_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.asset_ocr
    ADD CONSTRAINT "asset_ocr_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.asset
    ADD CONSTRAINT "asset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.asset
    ADD CONSTRAINT "asset_physicalOriginalFileId_fkey" FOREIGN KEY ("physicalOriginalFileId") REFERENCES public.physical_file(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.asset_restoration
    ADD CONSTRAINT "asset_restoration_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.asset_restoration
    ADD CONSTRAINT "asset_restoration_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES public.ml_destination(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.asset_restoration
    ADD CONSTRAINT "asset_restoration_fullOperationId_fkey" FOREIGN KEY ("fullOperationId") REFERENCES public.media_operation(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.asset_restoration
    ADD CONSTRAINT "asset_restoration_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.asset_restoration
    ADD CONSTRAINT "asset_restoration_previewOperationId_fkey" FOREIGN KEY ("previewOperationId") REFERENCES public.media_operation(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.asset
    ADD CONSTRAINT "asset_stackId_fkey" FOREIGN KEY ("stackId") REFERENCES public.stack(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.asset_upload_part
    ADD CONSTRAINT "asset_upload_part_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES public.asset_upload_resource(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.asset_upload_resource
    ADD CONSTRAINT "asset_upload_resource_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.asset_video_duplicate_frame
    ADD CONSTRAINT "asset_video_duplicate_frame_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.backup_device
    ADD CONSTRAINT "backup_device_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.backup_reconciliation
    ADD CONSTRAINT "backup_reconciliation_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES public.backup_device(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.backup_reconciliation
    ADD CONSTRAINT "backup_reconciliation_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.classification_match
    ADD CONSTRAINT "classification_match_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.classification_match
    ADD CONSTRAINT "classification_match_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES public.classification_rule(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.classification_rule
    ADD CONSTRAINT "classification_rule_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES public.album(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.classification_rule
    ADD CONSTRAINT "classification_rule_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.classification_rule
    ADD CONSTRAINT "classification_rule_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES public.tag(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.cloud_backup_manifest_original
    ADD CONSTRAINT "cloud_backup_manifest_original_manifestId_fkey" FOREIGN KEY ("manifestId") REFERENCES public.cloud_backup_manifest(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.cloud_backup_object_verification
    ADD CONSTRAINT "cloud_backup_object_verification_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES public.media_operation(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.cluster_group_request
    ADD CONSTRAINT "cluster_group_request_clusterGroupId_fkey" FOREIGN KEY ("clusterGroupId") REFERENCES public.cluster_group(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.cluster_group_request
    ADD CONSTRAINT "cluster_group_request_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.develop_export
    ADD CONSTRAINT "develop_export_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.develop_export
    ADD CONSTRAINT "develop_export_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.develop_preset
    ADD CONSTRAINT "develop_preset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.duplicate_decision
    ADD CONSTRAINT "duplicate_decision_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES public.media_operation(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.duplicate_decision
    ADD CONSTRAINT "duplicate_decision_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.duplicate_decision
    ADD CONSTRAINT "duplicate_decision_undoOperationId_fkey" FOREIGN KEY ("undoOperationId") REFERENCES public.media_operation(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.face_search
    ADD CONSTRAINT "face_search_faceId_fkey" FOREIGN KEY ("faceId") REFERENCES public.asset_face(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.icloud_album
    ADD CONSTRAINT "icloud_album_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES public.icloud_connection(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.icloud_identity_audit
    ADD CONSTRAINT icloud_audit_weekly_member FOREIGN KEY ("cohortId", "memberOrdinal", "ownerId", "connectionId", "grantId", "grantGeneration", "batchOrdinal") REFERENCES public.icloud_weekly_member("cohortId", ordinal, "ownerId", "connectionId", "grantId", "grantGeneration", "batchOrdinal");

ALTER TABLE ONLY public.icloud_checkpoint
    ADD CONSTRAINT "icloud_checkpoint_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES public.icloud_connection(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.icloud_identity_audit
    ADD CONSTRAINT "icloud_identity_audit_connectionId_ownerId_fkey" FOREIGN KEY ("connectionId", "ownerId") REFERENCES public.icloud_connection(id, "ownerId") ON DELETE CASCADE;

ALTER TABLE ONLY public.icloud_identity_reuse
    ADD CONSTRAINT "icloud_identity_reuse_connectionId_ownerId_fkey" FOREIGN KEY ("connectionId", "ownerId") REFERENCES public.icloud_connection(id, "ownerId") ON DELETE CASCADE;

ALTER TABLE ONLY public.icloud_membership
    ADD CONSTRAINT "icloud_membership_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES public.icloud_connection(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.icloud_record
    ADD CONSTRAINT "icloud_record_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES public.icloud_connection(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.icloud_resource
    ADD CONSTRAINT "icloud_resource_auditRequestId_fkey" FOREIGN KEY ("auditRequestId") REFERENCES public.icloud_identity_audit(id);

ALTER TABLE ONLY public.icloud_resource
    ADD CONSTRAINT "icloud_resource_connectionId_ownerId_fkey" FOREIGN KEY ("connectionId", "ownerId") REFERENCES public.icloud_connection(id, "ownerId") ON DELETE CASCADE;

ALTER TABLE ONLY public.icloud_run
    ADD CONSTRAINT "icloud_run_connectionId_ownerId_fkey" FOREIGN KEY ("connectionId", "ownerId") REFERENCES public.icloud_connection(id, "ownerId") ON DELETE CASCADE;

ALTER TABLE ONLY public.icloud_weekly_cohort
    ADD CONSTRAINT "icloud_weekly_cohort_connectionId_ownerId_fkey" FOREIGN KEY ("connectionId", "ownerId") REFERENCES public.icloud_connection(id, "ownerId") ON DELETE CASCADE;

ALTER TABLE ONLY public.icloud_weekly_cohort
    ADD CONSTRAINT "icloud_weekly_cohort_grantId_ownerId_connectionId_fkey" FOREIGN KEY ("grantId", "ownerId", "connectionId") REFERENCES public.icloud_weekly_grant(id, "ownerId", "connectionId");

ALTER TABLE ONLY public.icloud_weekly_grant
    ADD CONSTRAINT "icloud_weekly_grant_connectionId_ownerId_fkey" FOREIGN KEY ("connectionId", "ownerId") REFERENCES public.icloud_connection(id, "ownerId") ON DELETE CASCADE;

ALTER TABLE ONLY public.icloud_weekly_member
    ADD CONSTRAINT icloud_weekly_member_audit FOREIGN KEY ("auditRequestId", "cohortId", ordinal, "ownerId", "connectionId", "grantId", "grantGeneration", "batchOrdinal") REFERENCES public.icloud_identity_audit(id, "cohortId", "memberOrdinal", "ownerId", "connectionId", "grantId", "grantGeneration", "batchOrdinal") DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.icloud_weekly_member
    ADD CONSTRAINT "icloud_weekly_member_cohortId_ownerId_connectionId_fkey" FOREIGN KEY ("cohortId", "ownerId", "connectionId") REFERENCES public.icloud_weekly_cohort(id, "ownerId", "connectionId") ON DELETE CASCADE;

ALTER TABLE ONLY public.icloud_weekly_member
    ADD CONSTRAINT "icloud_weekly_member_cohortId_ownerId_connectionId_grantId_fkey" FOREIGN KEY ("cohortId", "ownerId", "connectionId", "grantId", "grantGeneration") REFERENCES public.icloud_weekly_cohort(id, "ownerId", "connectionId", "grantId", "grantGeneration");

ALTER TABLE ONLY public.integrity_report
    ADD CONSTRAINT "integrity_report_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.integrity_report
    ADD CONSTRAINT "integrity_report_fileAssetId_fkey" FOREIGN KEY ("fileAssetId") REFERENCES public.asset_file(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.job_attempt
    ADD CONSTRAINT "job_attempt_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES public.job(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.job_attempt
    ADD CONSTRAINT "job_attempt_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES public.job_worker(id);

ALTER TABLE ONLY public.job
    ADD CONSTRAINT "job_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES public.job(id);

ALTER TABLE ONLY public.job
    ADD CONSTRAINT job_queue_fkey FOREIGN KEY (queue) REFERENCES public.job_queue(name);

ALTER TABLE ONLY public.job
    ADD CONSTRAINT "job_runId_fkey" FOREIGN KEY ("runId") REFERENCES public.job_run(id);

ALTER TABLE ONLY public.job
    ADD CONSTRAINT "job_runId_itemKey_name_fkey" FOREIGN KEY ("runId", "itemKey", name) REFERENCES public.job_run_item("runId", "itemKey", stage);

ALTER TABLE ONLY public.job_run_item
    ADD CONSTRAINT job_run_item_queue_fkey FOREIGN KEY (queue) REFERENCES public.job_queue(name);

ALTER TABLE ONLY public.job_run_item
    ADD CONSTRAINT "job_run_item_runId_fkey" FOREIGN KEY ("runId") REFERENCES public.job_run(id);

ALTER TABLE ONLY public.job_run_item
    ADD CONSTRAINT "job_run_item_selectionId_fkey" FOREIGN KEY ("selectionId") REFERENCES public.job_selection(id);

ALTER TABLE ONLY public.job_selection
    ADD CONSTRAINT "job_selection_producerId_fkey" FOREIGN KEY ("producerId") REFERENCES public.job(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.job_selection
    ADD CONSTRAINT job_selection_queue_fkey FOREIGN KEY (queue) REFERENCES public.job_queue(name);

ALTER TABLE ONLY public.job_selection
    ADD CONSTRAINT "job_selection_runId_fkey" FOREIGN KEY ("runId") REFERENCES public.job_run(id);

ALTER TABLE ONLY public.job
    ADD CONSTRAINT "job_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES public.job_worker(id);

ALTER TABLE ONLY public.library
    ADD CONSTRAINT "library_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.media_operation
    ADD CONSTRAINT "media_operation_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.media_operation_checkpoint
    ADD CONSTRAINT "media_operation_checkpoint_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES public.media_operation(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.media_operation
    ADD CONSTRAINT "media_operation_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.media_operation
    ADD CONSTRAINT "media_operation_resultAssetId_fkey" FOREIGN KEY ("resultAssetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.media_operation
    ADD CONSTRAINT "media_operation_retryOfId_fkey" FOREIGN KEY ("retryOfId") REFERENCES public.media_operation(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.memory_asset
    ADD CONSTRAINT "memory_asset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.memory_asset_audit
    ADD CONSTRAINT "memory_asset_audit_memoryId_fkey" FOREIGN KEY ("memoryId") REFERENCES public.memory(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.memory_asset
    ADD CONSTRAINT "memory_asset_memoriesId_fkey" FOREIGN KEY ("memoriesId") REFERENCES public.memory(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.memory_export
    ADD CONSTRAINT "memory_export_memoryId_fkey" FOREIGN KEY ("memoryId") REFERENCES public.memory(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.memory_export
    ADD CONSTRAINT "memory_export_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.memory_export
    ADD CONSTRAINT "memory_export_studioExportVersionId_fkey" FOREIGN KEY ("studioExportVersionId") REFERENCES public.studio_export_version(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.memory_export
    ADD CONSTRAINT "memory_export_studioProjectId_fkey" FOREIGN KEY ("studioProjectId") REFERENCES public.studio_project(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.memory
    ADD CONSTRAINT "memory_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.ml_destination
    ADD CONSTRAINT "ml_destination_consentAcknowledgedBy_fkey" FOREIGN KEY ("consentAcknowledgedBy") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.ml_workload_accounting
    ADD CONSTRAINT "ml_workload_accounting_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES public.ml_destination(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.ml_workload_route
    ADD CONSTRAINT "ml_workload_route_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES public.ml_destination(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.notification
    ADD CONSTRAINT "notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.ocr_search
    ADD CONSTRAINT "ocr_search_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.operational_metric_sample
    ADD CONSTRAINT "operational_metric_sample_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES public.library(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.operational_metric_sample
    ADD CONSTRAINT "operational_metric_sample_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.partner
    ADD CONSTRAINT "partner_sharedById_fkey" FOREIGN KEY ("sharedById") REFERENCES public."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.partner
    ADD CONSTRAINT "partner_sharedWithId_fkey" FOREIGN KEY ("sharedWithId") REFERENCES public."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.person
    ADD CONSTRAINT "person_faceAssetId_fkey" FOREIGN KEY ("faceAssetId") REFERENCES public.asset_face(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.person_group
    ADD CONSTRAINT "person_group_clusterGroupId_fkey" FOREIGN KEY ("clusterGroupId") REFERENCES public.cluster_group(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.person
    ADD CONSTRAINT "person_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.person
    ADD CONSTRAINT "person_personGroupId_fkey" FOREIGN KEY ("personGroupId") REFERENCES public.person_group(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.pet_candidate
    ADD CONSTRAINT "pet_candidate_detectionId_fkey" FOREIGN KEY ("detectionId") REFERENCES public.pet_detection(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.pet_candidate
    ADD CONSTRAINT "pet_candidate_petId_fkey" FOREIGN KEY ("petId") REFERENCES public.pet(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.pet_detection
    ADD CONSTRAINT "pet_detection_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.pet
    ADD CONSTRAINT "pet_featuredAssetId_fkey" FOREIGN KEY ("featuredAssetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.pet_observation
    ADD CONSTRAINT "pet_observation_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.pet_observation
    ADD CONSTRAINT "pet_observation_petId_fkey" FOREIGN KEY ("petId") REFERENCES public.pet(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.pet
    ADD CONSTRAINT "pet_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.physical_file
    ADD CONSTRAINT "physical_file_canonicalAssetId_fkey" FOREIGN KEY ("canonicalAssetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.plugin_method
    ADD CONSTRAINT "plugin_method_pluginId_fkey" FOREIGN KEY ("pluginId") REFERENCES public.plugin(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.preservation_item
    ADD CONSTRAINT "preservation_item_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.preservation_item
    ADD CONSTRAINT "preservation_item_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES public.preservation_package(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.preservation_package
    ADD CONSTRAINT "preservation_package_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.preservation_restore_item
    ADD CONSTRAINT "preservation_restore_item_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.preservation_restore_item
    ADD CONSTRAINT "preservation_restore_item_restoreId_fkey" FOREIGN KEY ("restoreId") REFERENCES public.preservation_restore(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.preservation_restore
    ADD CONSTRAINT "preservation_restore_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.preservation_restore
    ADD CONSTRAINT "preservation_restore_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES public.preservation_package(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.push_device_activity
    ADD CONSTRAINT "push_device_activity_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES public.push_device(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.push_device
    ADD CONSTRAINT "push_device_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES public.session(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.push_device
    ADD CONSTRAINT "push_device_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.render_worker
    ADD CONSTRAINT "render_worker_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.render_worker_limit
    ADD CONSTRAINT "render_worker_limit_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.render_worker_session
    ADD CONSTRAINT "render_worker_session_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES public.render_worker(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.session
    ADD CONSTRAINT "session_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES public.session(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.session_sync_checkpoint
    ADD CONSTRAINT "session_sync_checkpoint_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES public.session(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.session_tag_sync_state
    ADD CONSTRAINT "session_tag_sync_state_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES public.session(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.session
    ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.shared_link
    ADD CONSTRAINT "shared_link_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES public.album(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.shared_link_asset
    ADD CONSTRAINT "shared_link_asset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.shared_link_asset
    ADD CONSTRAINT "shared_link_asset_sharedLinkId_fkey" FOREIGN KEY ("sharedLinkId") REFERENCES public.shared_link(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.shared_link
    ADD CONSTRAINT "shared_link_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.shared_space_album
    ADD CONSTRAINT "shared_space_album_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES public.album(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.shared_space_album
    ADD CONSTRAINT "shared_space_album_linkedAlbumId_fkey" FOREIGN KEY ("linkedAlbumId") REFERENCES public.album(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.shared_space_album
    ADD CONSTRAINT "shared_space_album_linkedById_fkey" FOREIGN KEY ("linkedById") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.shared_space_comment_thread
    ADD CONSTRAINT "shared_space_comment_thread_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES public.activity(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.shared_space_comment_thread
    ADD CONSTRAINT "shared_space_comment_thread_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES public.album(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.shared_space_comment_thread
    ADD CONSTRAINT "shared_space_comment_thread_parentActivityId_fkey" FOREIGN KEY ("parentActivityId") REFERENCES public.activity(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.shared_space_event
    ADD CONSTRAINT "shared_space_event_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES public.activity(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.shared_space_event
    ADD CONSTRAINT "shared_space_event_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.shared_space_event
    ADD CONSTRAINT "shared_space_event_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES public.album(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.shared_space_event
    ADD CONSTRAINT "shared_space_event_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.shared_space_invite
    ADD CONSTRAINT "shared_space_invite_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES public.album(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.shared_space_invite
    ADD CONSTRAINT "shared_space_invite_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.shared_space_invite
    ADD CONSTRAINT "shared_space_invite_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.shared_space_mention
    ADD CONSTRAINT "shared_space_mention_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES public.activity(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.shared_space_mention
    ADD CONSTRAINT "shared_space_mention_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.shared_space_person
    ADD CONSTRAINT "shared_space_person_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES public.album(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.shared_space_person
    ADD CONSTRAINT "shared_space_person_coverAssetId_fkey" FOREIGN KEY ("coverAssetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.shared_space_person
    ADD CONSTRAINT "shared_space_person_personGroupId_fkey" FOREIGN KEY ("personGroupId") REFERENCES public.person_group(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.shared_space_person
    ADD CONSTRAINT "shared_space_person_personOwnerId_fkey" FOREIGN KEY ("personOwnerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.shared_space_visit
    ADD CONSTRAINT "shared_space_visit_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES public.album(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.shared_space_visit
    ADD CONSTRAINT "shared_space_visit_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.smart_album
    ADD CONSTRAINT "smart_album_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES public.album(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.smart_album_asset
    ADD CONSTRAINT "smart_album_asset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.smart_album_asset
    ADD CONSTRAINT "smart_album_asset_smartAlbumId_fkey" FOREIGN KEY ("smartAlbumId") REFERENCES public.smart_album(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.smart_album_exclusion
    ADD CONSTRAINT "smart_album_exclusion_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.smart_album_exclusion
    ADD CONSTRAINT "smart_album_exclusion_smartAlbumId_fkey" FOREIGN KEY ("smartAlbumId") REFERENCES public.smart_album(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.smart_album
    ADD CONSTRAINT "smart_album_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.smart_search
    ADD CONSTRAINT "smart_search_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.smart_search_description
    ADD CONSTRAINT "smart_search_description_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.stack
    ADD CONSTRAINT "stack_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.stack
    ADD CONSTRAINT "stack_primaryAssetId_fkey" FOREIGN KEY ("primaryAssetId") REFERENCES public.asset(id);

ALTER TABLE ONLY public.studio_bundle_upload
    ADD CONSTRAINT "studio_bundle_upload_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.studio_export_remote_reference
    ADD CONSTRAINT "studio_export_remote_reference_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES public.studio_export_version(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.studio_export_version
    ADD CONSTRAINT "studio_export_version_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.studio_export_version
    ADD CONSTRAINT "studio_export_version_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES public.studio_project(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.studio_export_version
    ADD CONSTRAINT "studio_export_version_publishOperationId_fkey" FOREIGN KEY ("publishOperationId") REFERENCES public.media_operation(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.studio_export_version
    ADD CONSTRAINT "studio_export_version_renderOperationId_fkey" FOREIGN KEY ("renderOperationId") REFERENCES public.media_operation(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.studio_export_version
    ADD CONSTRAINT "studio_export_version_resultAssetId_fkey" FOREIGN KEY ("resultAssetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.studio_export_version_source
    ADD CONSTRAINT "studio_export_version_source_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES public.studio_export_version(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.studio_preview_frame
    ADD CONSTRAINT "studio_preview_frame_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES public.media_operation(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.studio_preview_frame
    ADD CONSTRAINT "studio_preview_frame_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.studio_project_comment
    ADD CONSTRAINT "studio_project_comment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.studio_project_comment
    ADD CONSTRAINT "studio_project_comment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES public.studio_project(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.studio_project_comment
    ADD CONSTRAINT "studio_project_comment_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.studio_project
    ADD CONSTRAINT "studio_project_duplicatedFromId_fkey" FOREIGN KEY ("duplicatedFromId") REFERENCES public.studio_project(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.studio_project
    ADD CONSTRAINT "studio_project_leaseHolderId_fkey" FOREIGN KEY ("leaseHolderId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.studio_project
    ADD CONSTRAINT "studio_project_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.studio_project_revision
    ADD CONSTRAINT "studio_project_revision_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.studio_project_revision
    ADD CONSTRAINT "studio_project_revision_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES public.studio_project(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.studio_project
    ADD CONSTRAINT "studio_project_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES public.album(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.studio_project
    ADD CONSTRAINT "studio_project_thumbnailAssetId_fkey" FOREIGN KEY ("thumbnailAssetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.tag_asset
    ADD CONSTRAINT "tag_asset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.tag_asset
    ADD CONSTRAINT "tag_asset_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES public.tag(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.tag_closure
    ADD CONSTRAINT tag_closure_id_ancestor_fkey FOREIGN KEY (id_ancestor) REFERENCES public.tag(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.tag_closure
    ADD CONSTRAINT tag_closure_id_descendant_fkey FOREIGN KEY (id_descendant) REFERENCES public.tag(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.tag
    ADD CONSTRAINT "tag_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES public.tag(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.tag
    ADD CONSTRAINT "tag_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.takeout_album
    ADD CONSTRAINT "takeout_album_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES public.album(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.takeout_album
    ADD CONSTRAINT "takeout_album_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.takeout_file
    ADD CONSTRAINT "takeout_file_importId_fkey" FOREIGN KEY ("importId") REFERENCES public.takeout_import(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.takeout_file
    ADD CONSTRAINT "takeout_file_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES public.takeout_source(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.takeout_import
    ADD CONSTRAINT "takeout_import_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.takeout_import
    ADD CONSTRAINT "takeout_import_runOperationId_fkey" FOREIGN KEY ("runOperationId") REFERENCES public.media_operation(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.takeout_item
    ADD CONSTRAINT "takeout_item_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.takeout_item
    ADD CONSTRAINT takeout_item_id_fkey FOREIGN KEY (id) REFERENCES public.takeout_file(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.takeout_pair
    ADD CONSTRAINT "takeout_pair_photoItemId_fkey" FOREIGN KEY ("photoItemId") REFERENCES public.takeout_item(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.takeout_pair
    ADD CONSTRAINT "takeout_pair_videoItemId_fkey" FOREIGN KEY ("videoItemId") REFERENCES public.takeout_item(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.takeout_source
    ADD CONSTRAINT "takeout_source_importId_fkey" FOREIGN KEY ("importId") REFERENCES public.takeout_import(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT "user_clusterGroupId_fkey" FOREIGN KEY ("clusterGroupId") REFERENCES public.cluster_group(id) ON UPDATE CASCADE;

ALTER TABLE ONLY public.user_metadata
    ADD CONSTRAINT "user_metadata_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT "user_profileImageAssetId_fkey" FOREIGN KEY ("profileImageAssetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.video_edit_selection
    ADD CONSTRAINT "video_edit_selection_currentVersionId_assetId_ownerId_fkey" FOREIGN KEY ("currentVersionId", "assetId", "ownerId") REFERENCES public.video_edit_version(id, "assetId", "ownerId");

ALTER TABLE ONLY public.video_edit_selection
    ADD CONSTRAINT "video_edit_selection_requestedVersionId_assetId_ownerId_fkey" FOREIGN KEY ("requestedVersionId", "assetId", "ownerId") REFERENCES public.video_edit_version(id, "assetId", "ownerId");

ALTER TABLE ONLY public.video_moment
    ADD CONSTRAINT "video_moment_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.video_moment
    ADD CONSTRAINT "video_moment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.video_moment
    ADD CONSTRAINT "video_moment_frameId_fkey" FOREIGN KEY ("frameId") REFERENCES public.video_moment_frame(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.video_moment_frame
    ADD CONSTRAINT "video_moment_frame_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.video_moment_frame_embedding
    ADD CONSTRAINT "video_moment_frame_embedding_frameId_fkey" FOREIGN KEY ("frameId") REFERENCES public.video_moment_frame(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.video_moment_index
    ADD CONSTRAINT "video_moment_index_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.video_moment_index
    ADD CONSTRAINT "video_moment_index_coverSetById_fkey" FOREIGN KEY ("coverSetById") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.video_stream_segment
    ADD CONSTRAINT "video_stream_segment_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES public.video_stream_variant(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.video_stream_session
    ADD CONSTRAINT "video_stream_session_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.video_stream_variant
    ADD CONSTRAINT "video_stream_variant_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES public.video_stream_session(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.workflow_definition
    ADD CONSTRAINT "workflow_definition_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES public.workflow(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.workflow_log_detail
    ADD CONSTRAINT "workflow_log_detail_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES public.workflow(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.workflow
    ADD CONSTRAINT "workflow_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.workflow_run_step
    ADD CONSTRAINT "workflow_run_step_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES public.workflow(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.workflow_step
    ADD CONSTRAINT "workflow_step_pluginMethodId_fkey" FOREIGN KEY ("pluginMethodId") REFERENCES public.plugin_method(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.workflow_step
    ADD CONSTRAINT "workflow_step_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES public.workflow(id) ON UPDATE CASCADE ON DELETE CASCADE;
