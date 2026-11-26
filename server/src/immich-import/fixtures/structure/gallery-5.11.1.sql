-- Noodle Gallery 5.11.1 tables the import reads or reports, added on top of the 3.2.0 structure.
-- Transcribed from the table declarations at tag v5.11.1 of open-noodle/gallery (server/src/schema/tables);
-- not a dump of a running install. Columns the import never reads, triggers, audit tables and indexes are left out.
CREATE TABLE "gallery_migrations" ("name" character varying(255) PRIMARY KEY, "timestamp" character varying(255) NOT NULL);

CREATE TABLE "shared_space" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "name" text NOT NULL,
  "description" text,
  "createdById" uuid NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "thumbnailAssetId" uuid REFERENCES "asset" ("id") ON DELETE SET NULL,
  "color" character varying(20),
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "shared_space_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "shared_space_member" (
  "spaceId" uuid NOT NULL REFERENCES "shared_space" ("id") ON DELETE CASCADE,
  "userId" uuid NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "role" character varying NOT NULL DEFAULT 'viewer',
  "joinedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "showInTimeline" boolean NOT NULL DEFAULT true,
  CONSTRAINT "shared_space_member_pkey" PRIMARY KEY ("spaceId", "userId")
);

CREATE TABLE "shared_space_asset" (
  "spaceId" uuid NOT NULL REFERENCES "shared_space" ("id") ON DELETE CASCADE,
  "assetId" uuid NOT NULL REFERENCES "asset" ("id") ON DELETE CASCADE,
  "addedById" uuid REFERENCES "user" ("id") ON DELETE SET NULL,
  "addedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "shared_space_asset_pkey" PRIMARY KEY ("spaceId", "assetId")
);

CREATE TABLE "shared_space_library" (
  "spaceId" uuid NOT NULL REFERENCES "shared_space" ("id") ON DELETE CASCADE,
  "libraryId" uuid NOT NULL REFERENCES "library" ("id") ON DELETE CASCADE,
  "addedById" uuid REFERENCES "user" ("id") ON DELETE SET NULL,
  CONSTRAINT "shared_space_library_pkey" PRIMARY KEY ("spaceId", "libraryId")
);

CREATE TABLE "shared_space_person" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "spaceId" uuid NOT NULL REFERENCES "shared_space" ("id") ON DELETE CASCADE,
  "name" character varying NOT NULL DEFAULT '',
  "representativeFaceId" uuid REFERENCES "asset_face" ("id") ON DELETE SET NULL,
  "isHidden" boolean NOT NULL DEFAULT false,
  "type" character varying NOT NULL DEFAULT 'person',
  "birthDate" date,
  CONSTRAINT "shared_space_person_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "shared_space_person_face" (
  "personId" uuid NOT NULL REFERENCES "shared_space_person" ("id") ON DELETE CASCADE,
  "assetFaceId" uuid NOT NULL REFERENCES "asset_face" ("id") ON DELETE CASCADE,
  CONSTRAINT "shared_space_person_face_pkey" PRIMARY KEY ("personId", "assetFaceId")
);

CREATE TABLE "asset_favorite" (
  "userId" uuid NOT NULL REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  "assetId" uuid NOT NULL REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "asset_favorite_pkey" PRIMARY KEY ("userId", "assetId")
);

CREATE TABLE "person_pet" (
  "personGroupId" uuid NOT NULL REFERENCES "person_group" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  "species" character varying,
  CONSTRAINT "person_pet_pkey" PRIMARY KEY ("personGroupId")
);

CREATE TABLE "user_group" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "name" text NOT NULL,
  "createdById" uuid NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  CONSTRAINT "user_group_pkey" PRIMARY KEY ("id")
);
