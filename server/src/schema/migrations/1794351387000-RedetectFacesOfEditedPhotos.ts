import { Kysely, sql } from 'kysely';

/**
 * FL-1387: face detection ran on the edited preview and stored its boxes as they were, although a stored
 * box is a box on the unedited picture. Photos and videos whose faces were last detected while an edited
 * preview existed are detected again: the overnight check picks up a cleared `facesRecognizedAt`, and a face
 * found again then takes the detector's box. Nothing is deleted here.
 *
 * A photo that still has an imported face without an embedding is left as it is: an ordinary detection
 * removes an imported face it does not find again, and with it the person its source gave it.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    UPDATE public.asset_job_status status
    SET "facesRecognizedAt" = NULL
    WHERE status."facesRecognizedAt" IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.asset_file file
        WHERE file."assetId" = status."assetId"
          AND file.type = 'preview'
          AND file."isEdited"
          AND file."createdAt" <= status."facesRecognizedAt"
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.asset_face face
        WHERE face."assetId" = status."assetId"
          AND face."sourceType" = 'machine-learning'
          AND NOT EXISTS (SELECT 1 FROM public.face_search search WHERE search."faceId" = face.id)
      )
  `.execute(db);
}

export async function down(): Promise<void> {}
