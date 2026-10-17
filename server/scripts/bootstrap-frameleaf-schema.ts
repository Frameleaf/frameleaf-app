import { Kysely } from 'kysely';
import { ConfigRepository } from '../src/repositories/config.repository.js';
import { getKyselyConfig } from '../src/utils/database.js';
import { bootstrapCandidate } from './schema-capture/bootstrap.js';

// Explicit development capture only. Runtime migrations never import this module.
if (process.argv[2] !== '--empty-development-database') {
  throw new Error('Usage: bootstrap-frameleaf-schema.ts --empty-development-database');
}
const db = new Kysely(getKyselyConfig(new ConfigRepository().getEnv().database.config));
try {
  await db.transaction().execute(bootstrapCandidate);
} finally {
  await db.destroy();
}
