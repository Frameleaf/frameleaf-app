/* eslint-disable unicorn/no-global-object-property-assignment, unicorn/no-top-level-assignment-in-function -- Test-only foreign-fetch fence and independent attempt counter. */
// Actual compiled API module bootstrap in a fresh OS process, with no inherited config cache.
const nativeFetch = fetch;
let foreignFetchAttempts = 0;
globalThis.fetch = (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    foreignFetchAttempts++;
    return Promise.reject(new Error('Synthetic restart foreign fetch refused'));
  }
  return nativeFetch(input, options);
};
let app;
let stage = 'module-import';
try {
  const { NestFactory } = await import('@nestjs/core');
  const { ApiModule } = await import('../../../dist/app.module.js');
  const { MachineLearningRepository } = await import('../../../dist/repositories/machine-learning.repository.js');
  const { SystemMetadataRepository } = await import('../../../dist/repositories/system-metadata.repository.js');
  stage = 'application-create';
  app = await NestFactory.create(ApiModule, { logger: false, abortOnError: false });
  stage = 'application-bootstrap';
  await app.init();
  stage = 'effective-worker-request';
  const worker = app.get(MachineLearningRepository);
  await worker.semanticMaskLocal(Buffer.from('FL310 synthetic media boundary; no private asset'), 'subject');
  const epoch = await app.get(SystemMetadataRepository).getEffectiveConfigEpoch();
  console.info(
    JSON.stringify({
      fullNestApiBootstrap: true,
      localUrls: worker.getLocalUrls(),
      epoch: epoch?.epoch,
      foreignFetchAttempts,
    }),
  );
} catch (error) {
  const category = error instanceof Error ? error.constructor.name : 'Unknown';
  console.error(`Synthetic full application restart did not qualify at ${stage} (${category})`);
  process.exitCode = 1;
} finally {
  if (app) await app.close();
}
