// Runs the existing verification contract outside the HTTPS event loop. No alternate verifier.
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');
const { verifyBundle, verifyNasCertification } = require('../.github/verify-release-bundle.cjs');
(async () => {
  const release = await verifyBundle(workerData.directory, workerData.tag, { authenticate: true });
  const nas = JSON.parse(await fs.readFile(path.join(workerData.directory, 'nas-manifest.json'), 'utf8'));
  const reports = workerData.receipts ? await verifyNasCertification(nas, release, workerData.receipts.receipts, { families: [workerData.receipts.family] }) : [];
  parentPort.postMessage({ release, nas, reports });
})().catch(() => parentPort.postMessage({ error: 'release_verification_failed' }));
