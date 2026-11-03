import { Kysely, sql } from 'kysely';

/**
 * FL-456: one ordered list of places to process in, plus a list of its own for any workload that needs
 * one. Seeded from the routes saved before so that an upgrade changes nothing a person can see:
 *
 * - The main list is this server, then the person's computers, then Frameleaf Cloud (owner, 2026-10-18).
 *   When desktop assistance was already turned on for an account, Frameleaf Desktops took search, faces
 *   and text first, so the main list keeps them first.
 * - A workload this server routed to itself on its own (`default` or pre-FL-490 route intent) follows the
 *   main list; it already runs here first.
 * - A workload an administrator pinned keeps exactly that place, alone: this server, their computers
 *   (a computer added by address) or Frameleaf Cloud. One pinned to nowhere stays off.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "ml_processing_order" (
    "scope" text NOT NULL,
    "sources" jsonb NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "ml_processing_order_sources_check" CHECK (jsonb_typeof(sources) = 'array'),
    CONSTRAINT "ml_processing_order_pkey" PRIMARY KEY ("scope")
  )`.execute(db);

  await sql`INSERT INTO ml_processing_order (scope, sources)
    SELECT 'default', CASE WHEN EXISTS (
      SELECT 1 FROM system_metadata
      WHERE key = 'frameleaf-desktop-assistance'
        AND jsonb_typeof(value->'accounts') = 'object'
        AND value->'accounts' <> '{}'::jsonb
    ) THEN '["desktops","local","cloud"]'::jsonb ELSE '["local","desktops","cloud"]'::jsonb END`.execute(db);

  await sql`INSERT INTO ml_processing_order (scope, sources)
    SELECT route.workload,
      CASE destination.kind
        WHEN 'local' THEN '["local"]'::jsonb
        WHEN 'lan' THEN '["desktops"]'::jsonb
        ELSE '["cloud"]'::jsonb
      END
    FROM ml_workload_route route
    JOIN ml_destination destination ON destination.id = route."destinationId"
    LEFT JOIN ml_workload_route_origin origin
      ON origin.workload = route.workload AND origin."destinationId" = route."destinationId"
    WHERE NOT (destination.kind = 'local' AND (origin.origin IS NULL OR origin.origin = 'default'))
    ON CONFLICT (scope) DO NOTHING`.execute(db);

  await sql`INSERT INTO ml_processing_order (scope, sources)
    SELECT origin.workload, '[]'::jsonb
    FROM ml_workload_route_origin origin
    WHERE origin.origin = 'pinned' AND origin."destinationId" IS NULL
      AND NOT EXISTS (SELECT 1 FROM ml_workload_route route WHERE route.workload = origin.workload)
    ON CONFLICT (scope) DO NOTHING`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "ml_processing_order"`.execute(db);
}
