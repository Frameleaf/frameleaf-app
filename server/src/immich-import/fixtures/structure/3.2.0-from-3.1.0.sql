-- Exact structural statements from pinned 3.2.4 migrations (same schema as 3.2.0).
ALTER TABLE "user" ALTER COLUMN "password" DROP NOT NULL;

ALTER TABLE "user" ALTER COLUMN "password" SET DEFAULT NULL;

ALTER TABLE "album" ALTER COLUMN "description" DROP NOT NULL;

ALTER TABLE "album" ALTER COLUMN "description" SET DEFAULT NULL;

ALTER TABLE "workflow" ADD "logging" boolean NOT NULL DEFAULT false;

CREATE TABLE "workflow_log" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "workflowId" uuid NOT NULL,
  "result" character varying NOT NULL,
  "workflowStepId" uuid,
  "triggerDataId" uuid,
  "runId" uuid NOT NULL,
  CONSTRAINT "workflow_log_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "workflow" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "workflow_log_workflowStepId_fkey" FOREIGN KEY ("workflowStepId") REFERENCES "workflow_step" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "workflow_log_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "asset_ocr" ADD "updatedAt" timestamp with time zone NOT NULL DEFAULT now();

CREATE TABLE "cluster_group" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "name" character varying,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updateId" uuid NOT NULL DEFAULT immich_uuid_v7(),
  CONSTRAINT "cluster_group_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "user" ADD "clusterGroupId" uuid;

ALTER TABLE "user" ALTER COLUMN "clusterGroupId" SET NOT NULL;

ALTER TABLE "user" ADD CONSTRAINT "user_clusterGroupId_fkey" FOREIGN KEY ("clusterGroupId") REFERENCES "cluster_group" ("id") ON UPDATE CASCADE ON DELETE NO ACTION;

CREATE TABLE "cluster_group_request" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "clusterGroupId" uuid NOT NULL,
  "userId" uuid NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "cluster_group_request_clusterGroupId_fkey" FOREIGN KEY ("clusterGroupId") REFERENCES "cluster_group" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "cluster_group_request_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "cluster_group_request_clusterGroupId_userId_uq" UNIQUE ("clusterGroupId", "userId"),
  CONSTRAINT "cluster_group_request_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "person_group" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "clusterGroupId" uuid NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "createId" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updateId" uuid NOT NULL DEFAULT immich_uuid_v7(),
  CONSTRAINT "person_group_clusterGroupId_fkey" FOREIGN KEY ("clusterGroupId") REFERENCES "cluster_group" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "person_group_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "person_group_audit" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "personGroupId" uuid NOT NULL,
  "clusterGroupId" uuid NOT NULL,
  "deletedAt" timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "person_group_audit_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "person" ADD "personGroupId" uuid;

ALTER TABLE "person" ALTER COLUMN "personGroupId" SET NOT NULL;

ALTER TABLE "person" ADD CONSTRAINT "person_personGroupId_fkey" FOREIGN KEY ("personGroupId") REFERENCES "person_group" ("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "person_audit" ADD "personGroupId" uuid;

ALTER TABLE "person_audit" ALTER COLUMN "personGroupId" SET NOT NULL;

ALTER TABLE "person_audit" DROP COLUMN "personId";

ALTER TABLE "asset_face" DROP CONSTRAINT "asset_face_personId_fkey";

ALTER TABLE "asset_face" RENAME COLUMN "personId" TO "personGroupId";

ALTER TABLE "asset_face" ADD CONSTRAINT "asset_face_personGroupId_fkey" FOREIGN KEY ("personGroupId") REFERENCES "person_group" ("id") ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "person" DROP CONSTRAINT "person_pkey";

ALTER TABLE "person" DROP COLUMN "id";

ALTER TABLE "person" ADD CONSTRAINT "person_pkey" PRIMARY KEY ("ownerId", "personGroupId");
