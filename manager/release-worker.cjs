// Runs the existing verification contract outside the HTTPS event loop. No alternate verifier.
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');
const { verifyBundle } = require('../.github/verify-release-bundle.cjs');
(async () => {
  const release = await verifyBundle(workerData.directory, workerData.tag, { authenticate: true });
  const nas = JSON.parse(await fs.readFile(path.join(workerData.directory, 'nas-manifest.json'), 'utf8'));
  parentPort.postMessage({ release, nas });
})().catch((error) => {
  // The UI shows one generic refusal; the log keeps the reason (old verifier, cosign/registry or GitHub unreachable).
  // fetch() reports DNS/TLS/socket failures as "fetch failed" with the detail in error.cause.
  const cause = error?.cause ? ` (${error.cause.code ?? error.cause.message ?? error.cause})` : '';
  // Messages can quote the unverified download, so control characters are escaped (no forged log lines).
  const reason = `${error?.message ?? error}${cause}`.replace(
    /[\u0000-\u001f\u007f-\u009f]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  console.error(`Release ${workerData.tag} verification failed: ${reason}`);
  parentPort.postMessage({ error: 'release_verification_failed' });
});
