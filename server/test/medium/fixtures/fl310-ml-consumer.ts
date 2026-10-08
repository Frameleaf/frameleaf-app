/* eslint-disable no-restricted-imports -- Standalone fresh-process fixture uses direct imports before application bootstrap. */
import { Kysely } from 'kysely';
import { ConfigRepository } from '../../../src/repositories/config.repository.js';
import { LoggingRepository } from '../../../src/repositories/logging.repository.js';
import { MachineLearningRepository } from '../../../src/repositories/machine-learning.repository.js';
import { MlDestinationRepository } from '../../../src/repositories/ml-destination.repository.js';
import { SystemMetadataRepository } from '../../../src/repositories/system-metadata.repository.js';
import type { DB } from '../../../src/schema/index.js';
import { readConfig } from '../../../src/utils/config.js';
import { getKyselyConfig } from '../../../src/utils/database.js';

// Fresh OS process, actual configuration/repository consumer; no inherited cache or fabricated receipt.
const db = new Kysely<DB>(getKyselyConfig({ connectionType: 'url', url: process.env.IMMICH_TEST_POSTGRES_URL! }));
try {
  const configRepo = new ConfigRepository();
  const logger = LoggingRepository.create();
  const metadataRepo = new SystemMetadataRepository(db);
  const effective = await readConfig({ configRepo, logger, metadataRepo });
  const worker = new MachineLearningRepository(logger, new MlDestinationRepository(db), configRepo, metadataRepo);
  worker.setup(effective.machineLearning);
  await worker.semanticMaskLocal(Buffer.from('FL310 synthetic media boundary; no private asset'), 'subject');
  console.info(
    JSON.stringify({
      freshProcess: true,
      localUrls: worker.getLocalUrls(),
      epoch: (await metadataRepo.getEffectiveConfigEpoch())?.epoch,
    }),
  );
} finally {
  await db.destroy();
}
