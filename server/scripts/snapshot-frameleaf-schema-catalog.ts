import { schemaFromDatabase } from '@frameleaf/sql-tools';
import { writeFile } from 'node:fs/promises';
import { ConfigRepository } from '../src/repositories/config.repository.js';

const destination = process.argv[2];
if (!destination) throw new Error('Usage: snapshot-frameleaf-schema-catalog.ts <output.json>');
const schema = await schemaFromDatabase({ connection: new ConfigRepository().getEnv().database.config });
await writeFile(destination, JSON.stringify(schema, null, 2) + '\n');
