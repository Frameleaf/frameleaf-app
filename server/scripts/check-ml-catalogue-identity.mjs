#!/usr/bin/env node
// Is this tree's machine-learning service one of the runtime revisions the desktop model catalogue names?
//
// A catalogue profile carries the hash of the service's preprocessing sources. The service only produces
// under a model identity whose hash is its own (`preprocessing_identity()` in
// machine-learning/frameleaf_ml/native_qualification.py). When the sources change after the catalogue was
// cut, this server's own AI refuses every catalogue identity, and after a desktop is granted smart search
// the server falls back to asking by model name: its vectors then carry no producer key.
//
// Exits 1 when the hash is not in the catalogue. Run it when cutting a release, after the catalogue.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const server = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(server, '..', 'machine-learning', 'frameleaf_ml');
const walk = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)],
  );
// The same files, in the same order, as preprocessing_identity(): models/**/*.py sorted, then four files.
const files = [
  ...walk(join(root, 'models'))
    .filter((file) => file.endsWith('.py'))
    .sort(),
  ...['main.py', 'schemas.py', 'config.py', 'producer_binding.py'].map((name) => join(root, name)),
];
const digest = createHash('sha256');
for (const file of files) {
  digest.update(Buffer.from(relative(root, file).split(sep).join('/')));
  digest.update(Buffer.from([0]));
  digest.update(readFileSync(file));
}
const identity = digest.digest('hex');
const catalogue = JSON.parse(readFileSync(join(server, 'resources', 'desktop', 'model-catalogue.json'), 'utf8'));
const revisions = new Map();
for (const profile of catalogue.profiles) {
  const known = revisions.get(profile.spec.preprocessingSha256) ?? new Set();
  known.add(profile.runtimeSourceRevision.slice(0, 8));
  revisions.set(profile.spec.preprocessingSha256, known);
}
const match = revisions.get(identity);
if (match) {
  console.log(`machine-learning ${identity.slice(0, 12)} is catalogue runtime revision ${[...match].join(', ')}`);
} else {
  console.error(
    `machine-learning ${identity.slice(0, 12)} is not in the desktop model catalogue (${revisions.size} revisions: ` +
      `${[...revisions.keys()].map((hash) => hash.slice(0, 12)).join(', ')}).\n` +
      'This server would refuse every catalogue model identity and fall back to asking by model name.',
  );
  process.exitCode = 1;
}
