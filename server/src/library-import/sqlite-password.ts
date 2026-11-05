import { DatabaseSync } from 'node:sqlite';
import {
  ImportedPassword,
  ImportedPasswordContext,
  ImportedPasswordFormat,
  captureImportedPasswordContext,
} from 'src/library-import/passwords.js';

import { assertSqliteTextSafe } from 'src/library-import/sqlite.js';

/** Call only on an admitted snapshot, with a fixed adapter-owned query and an explicit owner mapping. */
export const readSqlitePassword = async (
  database: DatabaseSync,
  input: ImportedPasswordContext,
  format: ImportedPasswordFormat,
  query: string,
): Promise<ImportedPassword | undefined> => {
  try {
    const context = captureImportedPasswordContext(input);
    assertSqliteTextSafe(database, query, [context.sourceUserId]);
    const row = database.prepare(query).get(context.sourceUserId);
    if (!row) throw new Error('Source owner missing');
    if (row.password === null || row.password === '') return;
    const django = format === 'django-pbkdf2-sha256' || format === 'django-password';
    // Django's set_unusable_password() marker selects the secure-claim fallback rather than refusing the import.
    if (django && typeof row.password === 'string' && row.password.startsWith('!')) return;
    if (typeof row.password !== 'string') throw new Error('Source password encoding unsupported');
    return await ImportedPassword.fromSource(context, format, row.password);
  } catch {
    // SQLite errors can contain SQL and credential values.
    throw new Error('Imported password refused: SOURCE_PASSWORD_UNAVAILABLE');
  }
};
