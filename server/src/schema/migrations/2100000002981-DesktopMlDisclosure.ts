import { Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Older tasks cannot prove source authority at disclosure and are refused by the input service.
  await db.schema.alterTable('desktop_ml_task').addColumn('disclosure', 'jsonb').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('desktop_ml_task').dropColumn('disclosure').execute();
}
