// Runs the existing verification contract outside the HTTPS event loop. No alternate verifier.
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');
const { verifyBundle } = require('../.github/verify-release-bundle.cjs');
(async () => {
  const release = await verifyBundle(workerData.directory, workerData.tag, { authenticate: true });
  const nas = JSON.parse(await fs.readFile(path.join(workerData.directory, 'nas-manifest.json'), 'utf8'));
  parentPort.postMessage({ release, nas });
})().catch(() => parentPort.postMessage({ error: 'release_verification_failed' }));
