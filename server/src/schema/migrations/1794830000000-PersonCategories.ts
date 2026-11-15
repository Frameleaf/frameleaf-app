import { Kysely, sql } from 'kysely';

/** FL-874: an owner's categories for their people (Family, Friends, Work …) and who is in each. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "person_category" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "ownerId" uuid NOT NULL,
  "name" text NOT NULL,
  "color" text,
  "order" integer NOT NULL DEFAULT 0,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "person_category_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "person_category_id_ownerId_uq" UNIQUE ("id", "ownerId"),
  CONSTRAINT "person_category_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "person_category_ownerId_order_idx" ON "person_category" ("ownerId", "order");`.execute(db);
  await sql`CREATE TABLE "person_category_member" (
  "ownerId" uuid NOT NULL,
  "personId" uuid NOT NULL,
  "categoryId" uuid NOT NULL,
  CONSTRAINT "person_category_member_categoryId_ownerId_fkey" FOREIGN KEY ("categoryId", "ownerId") REFERENCES "person_category" ("id", "ownerId") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "person_category_member_ownerId_personId_fkey" FOREIGN KEY ("ownerId", "personId") REFERENCES "person" ("ownerId", "personGroupId") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "person_category_member_pkey" PRIMARY KEY ("ownerId", "personId", "categoryId")
);`.execute(db);
  await sql`CREATE INDEX "person_category_member_categoryId_idx" ON "person_category_member" ("categoryId");`.execute(db);
  await sql`CREATE TABLE "person_category_seed" (
  "ownerId" uuid NOT NULL,
  "seededAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "person_category_seed_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "person_category_seed_pkey" PRIMARY KEY ("ownerId")
);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "person_category_seed";`.execute(db);
  await sql`DROP TABLE "person_category_member";`.execute(db);
  await sql`DROP TABLE "person_category";`.execute(db);
}
