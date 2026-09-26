import { Kysely } from 'kysely';
import { fileURLToPath } from 'node:url';
import { GenericContainer, Wait } from 'testcontainers';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { getKyselyConfig } from 'src/utils/database.js';

// Frameleaf's own Postgres image source; medium tests build it rather than pull a prebuilt database image.
const postgresImageContext = fileURLToPath(new URL('../../../docker/postgres', import.meta.url));

const globalSetup = async () => {
  const templateName = 'mich';
  // The Dockerfile falls back to dpkg for its architecture, so the default builder is enough.
  const postgresImage = await GenericContainer.fromDockerfile(postgresImageContext).build('frameleaf-postgres:medium', {
    deleteOnExit: false,
  });
  const postgresContainer = await postgresImage
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_PASSWORD: 'postgres',
      POSTGRES_USER: 'postgres',
      POSTGRES_DB: templateName,
    })
    .withCommand([
      'postgres',
      '-c',
      'shared_preload_libraries=vchord.so',
      '-c',
      'max_wal_size=2GB',
      '-c',
      'shared_buffers=512MB',
      '-c',
      'fsync=off',
      '-c',
      'full_page_writes=off',
      '-c',
      'synchronous_commit=off',
      '-c',
      'config_file=/var/lib/postgresql/data/postgresql.conf',
    ])
    .withWaitStrategy(Wait.forAll([Wait.forLogMessage('database system is ready to accept connections', 2)]))
    .start();

  const postgresPort = postgresContainer.getMappedPort(5432);
  const postgresUrl = `postgres://postgres:postgres@localhost:${postgresPort}/${templateName}`;

  process.env.IMMICH_TEST_POSTGRES_URL = postgresUrl;

  const db = new Kysely<DB>(getKyselyConfig({ connectionType: 'url', url: postgresUrl }));

  const configRepository = new ConfigRepository();
  const logger = LoggingRepository.create();
  const databaseRepository = new DatabaseRepository(db, logger, configRepository);
  await databaseRepository.runMigrations();
  await databaseRepository.runForkMigrations();

  await db.destroy();
};

export default globalSetup;
