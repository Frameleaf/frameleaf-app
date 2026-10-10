-- Structural DDL extracted verbatim from the existing exact-tag 3.1.0 pg_dump. No rows, triggers, or vector indexes.
CREATE TYPE public.album_user_role_enum AS ENUM (
    'owner',
    'editor',
    'viewer'
);

CREATE TYPE public.asset_checksum_algorithm_enum AS ENUM (
    'sha1',
    'sha1-path'
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

CREATE FUNCTION public.immich_uuid_v7(p_timestamp timestamp with time zone DEFAULT clock_timestamp()) RETURNS uuid
    LANGUAGE sql
    AS $$
    select encode(
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

CREATE TABLE public.album (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "albumName" character varying DEFAULT 'Untitled Album'::character varying NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "albumThumbnailAssetId" uuid,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    "deletedAt" timestamp with time zone,
    "isActivityEnabled" boolean DEFAULT true NOT NULL,
    "order" character varying DEFAULT 'desc'::character varying NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL
);

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

CREATE TABLE public.album_user (
    "albumId" uuid NOT NULL,
    "userId" uuid NOT NULL,
    role public.album_user_role_enum DEFAULT 'editor'::public.album_user_role_enum NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "createId" uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.album_user_audit (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "albumId" uuid NOT NULL,
    "userId" uuid NOT NULL,
    "deletedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE public.api_key (
    name character varying NOT NULL,
    key bytea NOT NULL,
    "userId" uuid NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    permissions character varying[] NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL
);

CREATE TABLE public.asset (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "ownerId" uuid NOT NULL,
    type character varying NOT NULL,
    "originalPath" character varying NOT NULL,
    "fileCreatedAt" timestamp with time zone NOT NULL,
    "fileModifiedAt" timestamp with time zone NOT NULL,
    "isFavorite" boolean DEFAULT false NOT NULL,
    duration integer,
    checksum bytea NOT NULL,
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
    "checksumAlgorithm" public.asset_checksum_algorithm_enum NOT NULL
);

CREATE TABLE public.asset_audio (
    "assetId" uuid NOT NULL,
    bitrate integer NOT NULL,
    index smallint NOT NULL,
    profile smallint,
    "codecName" text NOT NULL
);

CREATE TABLE public.asset_audit (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "assetId" uuid NOT NULL,
    "ownerId" uuid NOT NULL,
    "deletedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
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
    "updatedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "lockedProperties" character varying[],
    tags character varying[]
);

CREATE TABLE public.asset_face (
    "assetId" uuid NOT NULL,
    "personId" uuid,
    "imageWidth" integer DEFAULT 0 NOT NULL,
    "imageHeight" integer DEFAULT 0 NOT NULL,
    "boundingBoxX1" integer DEFAULT 0 NOT NULL,
    "boundingBoxY1" integer DEFAULT 0 NOT NULL,
    "boundingBoxX2" integer DEFAULT 0 NOT NULL,
    "boundingBoxY2" integer DEFAULT 0 NOT NULL,
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "sourceType" public.sourcetype DEFAULT 'machine-learning'::public.sourcetype NOT NULL,
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
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "isEdited" boolean DEFAULT false NOT NULL,
    "isProgressive" boolean DEFAULT false NOT NULL,
    "isTransparent" boolean DEFAULT false NOT NULL
);

CREATE TABLE public.asset_job_status (
    "assetId" uuid NOT NULL,
    "facesRecognizedAt" timestamp with time zone,
    "metadataExtractedAt" timestamp with time zone,
    "duplicatesDetectedAt" timestamp with time zone,
    "ocrAt" timestamp with time zone
);

CREATE TABLE public.asset_keyframe (
    "assetId" uuid NOT NULL,
    pts integer[] NOT NULL,
    "accDuration" integer[] NOT NULL,
    "ownDuration" integer[] NOT NULL,
    "totalDuration" integer NOT NULL,
    "packetCount" integer NOT NULL,
    "outputFrames" integer NOT NULL
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
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL
);

CREATE TABLE public.asset_ocr_audit (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "assetId" uuid NOT NULL,
    "deletedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE public.asset_video (
    "assetId" uuid NOT NULL,
    bitrate integer NOT NULL,
    "frameCount" integer NOT NULL,
    "timeBase" integer NOT NULL,
    index smallint NOT NULL,
    profile smallint,
    level smallint,
    "colorPrimaries" smallint NOT NULL,
    "colorTransfer" smallint NOT NULL,
    "colorMatrix" smallint NOT NULL,
    "dvProfile" smallint,
    "dvLevel" smallint,
    "dvBlSignalCompatibilityId" smallint,
    "codecName" text NOT NULL,
    "formatName" text NOT NULL,
    "formatLongName" text NOT NULL,
    "pixelFormat" text NOT NULL
);

CREATE TABLE public.face_search (
    "faceId" uuid NOT NULL,
    embedding public.vector(512) NOT NULL
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

CREATE TABLE public.integrity_report (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    type character varying NOT NULL,
    path character varying NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "assetId" uuid,
    "fileAssetId" uuid
);

CREATE TABLE public.kysely_migrations (
    name character varying(255) NOT NULL,
    "timestamp" character varying(255) NOT NULL
);

CREATE TABLE public.kysely_migrations_lock (
    id character varying(255) NOT NULL,
    is_locked integer DEFAULT 0 NOT NULL
);

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

CREATE TABLE public.migration_overrides (
    name character varying NOT NULL,
    value jsonb NOT NULL
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

CREATE TABLE public.partner (
    "sharedById" uuid NOT NULL,
    "sharedWithId" uuid NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "inTimeline" boolean DEFAULT false NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "createId" uuid DEFAULT public.immich_uuid_v7() NOT NULL
);

CREATE TABLE public.partner_audit (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "sharedById" uuid NOT NULL,
    "sharedWithId" uuid NOT NULL,
    "deletedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

CREATE TABLE public.person (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "ownerId" uuid NOT NULL,
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
    "personId" uuid NOT NULL,
    "ownerId" uuid NOT NULL,
    "deletedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
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
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    templates jsonb NOT NULL,
    sha256hash bytea NOT NULL
);

CREATE TABLE public.plugin_method (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "pluginId" uuid NOT NULL,
    name character varying NOT NULL,
    title character varying NOT NULL,
    description character varying NOT NULL,
    types character varying[] NOT NULL,
    "hostFunctions" boolean DEFAULT false NOT NULL,
    "uiHints" character varying[] DEFAULT '{}'::character varying[] NOT NULL,
    schema jsonb,
    "allowedHosts" character varying[] DEFAULT '{}'::character varying[] NOT NULL
);

CREATE TABLE public.session (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    token bytea NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "userId" uuid NOT NULL,
    "deviceType" character varying DEFAULT ''::character varying NOT NULL,
    "deviceOS" character varying DEFAULT ''::character varying NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "pinExpiresAt" timestamp with time zone,
    "expiresAt" timestamp with time zone,
    "parentId" uuid,
    "isPendingSyncReset" boolean DEFAULT false NOT NULL,
    "appVersion" character varying,
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

CREATE TABLE public.smart_search (
    "assetId" uuid NOT NULL,
    embedding public.vector(512) NOT NULL
);

CREATE TABLE public.stack (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "primaryAssetId" uuid NOT NULL,
    "ownerId" uuid NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL
);

CREATE TABLE public.stack_audit (
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "stackId" uuid NOT NULL,
    "userId" uuid NOT NULL,
    "deletedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
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
    "assetId" uuid NOT NULL,
    "tagId" uuid NOT NULL
);

CREATE TABLE public.tag_closure (
    id_ancestor uuid NOT NULL,
    id_descendant uuid NOT NULL
);

CREATE TABLE public."user" (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    email character varying NOT NULL,
    password character varying DEFAULT ''::character varying NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "profileImagePath" character varying DEFAULT ''::character varying NOT NULL,
    "isAdmin" boolean DEFAULT false NOT NULL,
    "shouldChangePassword" boolean DEFAULT true NOT NULL,
    "deletedAt" timestamp with time zone,
    "oauthId" character varying DEFAULT ''::character varying NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "storageLabel" character varying,
    name character varying DEFAULT ''::character varying NOT NULL,
    "quotaSizeInBytes" bigint,
    "quotaUsageInBytes" bigint DEFAULT 0 NOT NULL,
    status character varying DEFAULT 'active'::character varying NOT NULL,
    "profileChangedAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updateId" uuid DEFAULT public.immich_uuid_v7() NOT NULL,
    "avatarColor" character varying,
    "pinCode" character varying
);

CREATE TABLE public.user_audit (
    "userId" uuid NOT NULL,
    "deletedAt" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    id uuid DEFAULT public.immich_uuid_v7() NOT NULL
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

CREATE TABLE public.version_history (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    version character varying NOT NULL
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
    enabled boolean DEFAULT true NOT NULL
);

CREATE TABLE public.workflow_step (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    "workflowId" uuid NOT NULL,
    "pluginMethodId" uuid NOT NULL,
    config jsonb,
    "order" integer NOT NULL
);

ALTER TABLE ONLY public.move_history
    ADD CONSTRAINT "UQ_entityId_pathType" UNIQUE ("entityId", "pathType");

ALTER TABLE ONLY public.move_history
    ADD CONSTRAINT "UQ_newPath" UNIQUE ("newPath");

ALTER TABLE ONLY public.activity
    ADD CONSTRAINT activity_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.album_asset_audit
    ADD CONSTRAINT album_asset_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.album_asset
    ADD CONSTRAINT album_asset_pkey PRIMARY KEY ("albumId", "assetId");

ALTER TABLE ONLY public.album_audit
    ADD CONSTRAINT album_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.album
    ADD CONSTRAINT album_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.album_user_audit
    ADD CONSTRAINT album_user_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.album_user
    ADD CONSTRAINT album_user_pkey PRIMARY KEY ("albumId", "userId");

ALTER TABLE ONLY public.api_key
    ADD CONSTRAINT api_key_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.asset_audio
    ADD CONSTRAINT asset_audio_pkey PRIMARY KEY ("assetId");

ALTER TABLE ONLY public.asset_audit
    ADD CONSTRAINT asset_audit_pkey PRIMARY KEY (id);

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

ALTER TABLE ONLY public.asset_job_status
    ADD CONSTRAINT asset_job_status_pkey PRIMARY KEY ("assetId");

ALTER TABLE ONLY public.asset_keyframe
    ADD CONSTRAINT asset_keyframe_pkey PRIMARY KEY ("assetId");

ALTER TABLE ONLY public.asset_metadata_audit
    ADD CONSTRAINT asset_metadata_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.asset_metadata
    ADD CONSTRAINT asset_metadata_pkey PRIMARY KEY ("assetId", key);

ALTER TABLE ONLY public.asset_ocr_audit
    ADD CONSTRAINT asset_ocr_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.asset_ocr
    ADD CONSTRAINT asset_ocr_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.asset
    ADD CONSTRAINT asset_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.asset_video
    ADD CONSTRAINT asset_video_pkey PRIMARY KEY ("assetId");

ALTER TABLE ONLY public.face_search
    ADD CONSTRAINT face_search_pkey PRIMARY KEY ("faceId");

ALTER TABLE ONLY public.geodata_places
    ADD CONSTRAINT geodata_places_pkey PRIMARY KEY (id) WITH (fillfactor='100');

ALTER TABLE ONLY public.integrity_report
    ADD CONSTRAINT integrity_report_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.integrity_report
    ADD CONSTRAINT integrity_report_type_path_uq UNIQUE (type, path);

ALTER TABLE ONLY public.kysely_migrations_lock
    ADD CONSTRAINT kysely_migrations_lock_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.kysely_migrations
    ADD CONSTRAINT kysely_migrations_pkey PRIMARY KEY (name);

ALTER TABLE ONLY public.library
    ADD CONSTRAINT library_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.memory_asset_audit
    ADD CONSTRAINT memory_asset_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.memory_asset
    ADD CONSTRAINT memory_asset_pkey PRIMARY KEY ("memoriesId", "assetId");

ALTER TABLE ONLY public.memory_audit
    ADD CONSTRAINT memory_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.memory
    ADD CONSTRAINT memory_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.migration_overrides
    ADD CONSTRAINT migration_overrides_pkey PRIMARY KEY (name);

ALTER TABLE ONLY public.move_history
    ADD CONSTRAINT move_history_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.naturalearth_countries
    ADD CONSTRAINT naturalearth_countries_pkey PRIMARY KEY (id) WITH (fillfactor='100');

ALTER TABLE ONLY public.notification
    ADD CONSTRAINT notification_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ocr_search
    ADD CONSTRAINT ocr_search_pkey PRIMARY KEY ("assetId");

ALTER TABLE ONLY public.partner_audit
    ADD CONSTRAINT partner_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.partner
    ADD CONSTRAINT partner_pkey PRIMARY KEY ("sharedById", "sharedWithId");

ALTER TABLE ONLY public.person_audit
    ADD CONSTRAINT person_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.person
    ADD CONSTRAINT person_pkey PRIMARY KEY (id);

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

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.session_sync_checkpoint
    ADD CONSTRAINT session_sync_checkpoint_pkey PRIMARY KEY ("sessionId", type);

ALTER TABLE ONLY public.shared_link_asset
    ADD CONSTRAINT shared_link_asset_pkey PRIMARY KEY ("assetId", "sharedLinkId");

ALTER TABLE ONLY public.shared_link
    ADD CONSTRAINT shared_link_key_uq UNIQUE (key);

ALTER TABLE ONLY public.shared_link
    ADD CONSTRAINT shared_link_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.shared_link
    ADD CONSTRAINT shared_link_slug_uq UNIQUE (slug);

ALTER TABLE ONLY public.smart_search
    ADD CONSTRAINT smart_search_pkey PRIMARY KEY ("assetId");

ALTER TABLE ONLY public.stack_audit
    ADD CONSTRAINT stack_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.stack
    ADD CONSTRAINT stack_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.stack
    ADD CONSTRAINT "stack_primaryAssetId_uq" UNIQUE ("primaryAssetId");

ALTER TABLE ONLY public.system_metadata
    ADD CONSTRAINT system_metadata_pkey PRIMARY KEY (key);

ALTER TABLE ONLY public.tag_asset
    ADD CONSTRAINT tag_asset_pkey PRIMARY KEY ("assetId", "tagId");

ALTER TABLE ONLY public.tag_closure
    ADD CONSTRAINT tag_closure_pkey PRIMARY KEY (id_ancestor, id_descendant);

ALTER TABLE ONLY public.tag
    ADD CONSTRAINT tag_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.tag
    ADD CONSTRAINT "tag_userId_value_uq" UNIQUE ("userId", value);

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

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT "user_storageLabel_uq" UNIQUE ("storageLabel");

ALTER TABLE ONLY public.version_history
    ADD CONSTRAINT version_history_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.video_stream_segment
    ADD CONSTRAINT video_stream_segment_pkey PRIMARY KEY ("variantId", index);

ALTER TABLE ONLY public.video_stream_session
    ADD CONSTRAINT video_stream_session_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.video_stream_variant
    ADD CONSTRAINT video_stream_variant_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.workflow
    ADD CONSTRAINT workflow_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.workflow_step
    ADD CONSTRAINT workflow_step_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.activity
    ADD CONSTRAINT "activity_albumId_assetId_fkey" FOREIGN KEY ("albumId", "assetId") REFERENCES public.album_asset("albumId", "assetId") ON DELETE CASCADE;

ALTER TABLE ONLY public.activity
    ADD CONSTRAINT "activity_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES public.album(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.activity
    ADD CONSTRAINT "activity_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.activity
    ADD CONSTRAINT "activity_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.album
    ADD CONSTRAINT "album_albumThumbnailAssetId_fkey" FOREIGN KEY ("albumThumbnailAssetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.album_asset
    ADD CONSTRAINT "album_asset_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES public.album(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.album_asset
    ADD CONSTRAINT "album_asset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.album_asset_audit
    ADD CONSTRAINT "album_asset_audit_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES public.album(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.album_user
    ADD CONSTRAINT "album_user_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES public.album(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.album_user
    ADD CONSTRAINT "album_user_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.api_key
    ADD CONSTRAINT "api_key_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.asset_audio
    ADD CONSTRAINT "asset_audio_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.asset_edit
    ADD CONSTRAINT "asset_edit_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.asset_exif
    ADD CONSTRAINT "asset_exif_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.asset_face
    ADD CONSTRAINT "asset_face_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.asset_face
    ADD CONSTRAINT "asset_face_personId_fkey" FOREIGN KEY ("personId") REFERENCES public.person(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.asset_file
    ADD CONSTRAINT "asset_file_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.asset_job_status
    ADD CONSTRAINT "asset_job_status_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.asset_keyframe
    ADD CONSTRAINT "asset_keyframe_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.asset
    ADD CONSTRAINT "asset_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES public.library(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.asset
    ADD CONSTRAINT "asset_livePhotoVideoId_fkey" FOREIGN KEY ("livePhotoVideoId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.asset_metadata
    ADD CONSTRAINT "asset_metadata_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.asset_ocr
    ADD CONSTRAINT "asset_ocr_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.asset
    ADD CONSTRAINT "asset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.asset
    ADD CONSTRAINT "asset_stackId_fkey" FOREIGN KEY ("stackId") REFERENCES public.stack(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.asset_video
    ADD CONSTRAINT "asset_video_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.face_search
    ADD CONSTRAINT "face_search_faceId_fkey" FOREIGN KEY ("faceId") REFERENCES public.asset_face(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.integrity_report
    ADD CONSTRAINT "integrity_report_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.integrity_report
    ADD CONSTRAINT "integrity_report_fileAssetId_fkey" FOREIGN KEY ("fileAssetId") REFERENCES public.asset_file(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.library
    ADD CONSTRAINT "library_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.memory_asset
    ADD CONSTRAINT "memory_asset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.memory_asset_audit
    ADD CONSTRAINT "memory_asset_audit_memoryId_fkey" FOREIGN KEY ("memoryId") REFERENCES public.memory(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.memory_asset
    ADD CONSTRAINT "memory_asset_memoriesId_fkey" FOREIGN KEY ("memoriesId") REFERENCES public.memory(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.memory
    ADD CONSTRAINT "memory_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.notification
    ADD CONSTRAINT "notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.ocr_search
    ADD CONSTRAINT "ocr_search_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.partner
    ADD CONSTRAINT "partner_sharedById_fkey" FOREIGN KEY ("sharedById") REFERENCES public."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.partner
    ADD CONSTRAINT "partner_sharedWithId_fkey" FOREIGN KEY ("sharedWithId") REFERENCES public."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.person
    ADD CONSTRAINT "person_faceAssetId_fkey" FOREIGN KEY ("faceAssetId") REFERENCES public.asset_face(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.person
    ADD CONSTRAINT "person_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.plugin_method
    ADD CONSTRAINT "plugin_method_pluginId_fkey" FOREIGN KEY ("pluginId") REFERENCES public.plugin(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.session
    ADD CONSTRAINT "session_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES public.session(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.session_sync_checkpoint
    ADD CONSTRAINT "session_sync_checkpoint_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES public.session(id) ON UPDATE CASCADE ON DELETE CASCADE;

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

ALTER TABLE ONLY public.smart_search
    ADD CONSTRAINT "smart_search_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.stack
    ADD CONSTRAINT "stack_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.stack
    ADD CONSTRAINT "stack_primaryAssetId_fkey" FOREIGN KEY ("primaryAssetId") REFERENCES public.asset(id);

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

ALTER TABLE ONLY public.user_metadata
    ADD CONSTRAINT "user_metadata_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.video_stream_segment
    ADD CONSTRAINT "video_stream_segment_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES public.video_stream_variant(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.video_stream_session
    ADD CONSTRAINT "video_stream_session_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES public.asset(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.video_stream_variant
    ADD CONSTRAINT "video_stream_variant_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES public.video_stream_session(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.workflow
    ADD CONSTRAINT "workflow_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.workflow_step
    ADD CONSTRAINT "workflow_step_pluginMethodId_fkey" FOREIGN KEY ("pluginMethodId") REFERENCES public.plugin_method(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.workflow_step
    ADD CONSTRAINT "workflow_step_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES public.workflow(id) ON UPDATE CASCADE ON DELETE CASCADE;

CREATE UNIQUE INDEX "UQ_assets_owner_checksum" ON public.asset USING btree ("ownerId", checksum) WHERE ("libraryId" IS NULL);

CREATE UNIQUE INDEX activity_like_idx ON public.activity USING btree ("assetId", "userId", "albumId") WHERE ("isLiked" = true);

CREATE UNIQUE INDEX album_user_unique_owner ON public.album_user USING btree ("albumId") WHERE (role = 'owner'::public.album_user_role_enum);

CREATE UNIQUE INDEX "asset_ownerId_libraryId_checksum_idx" ON public.asset USING btree ("ownerId", "libraryId", checksum) WHERE ("libraryId" IS NOT NULL);

CREATE UNIQUE INDEX "video_stream_variant_sessionId_bitrate_resolution_codec_idx" ON public.video_stream_variant USING btree ("sessionId", bitrate, resolution, codec);

ALTER TABLE public.naturalearth_countries ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.naturalearth_countries_tmp_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    MAXVALUE 2147483647
    CACHE 1
);
