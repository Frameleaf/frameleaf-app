#!/usr/bin/env node
// Can this tree's machine-learning service do smart search for every search model in the desktop catalogue?
//
// A catalogue profile carries the hash of the service's preprocessing sources. The service only produces
// under a model identity whose hash is its own (`preprocessing_identity()` in
// machine-learning/frameleaf_ml/native_qualification.py). Once a desktop is granted smart search, this
// server asks its own AI under a catalogue identity: any runtime revision's key of the same encoder will
// do (they name one embedding space), but one of them has to be this build's. So for every search model,
// and every request it has a profile for (the image encoder and each text encoder), the catalogue needs a
// profile with this build's hash. When the sources change and the catalogue is not recut, the server's own
// photo embedding and searching by words fail after the first desktop is granted smart search.
//
// Exits 1 when a request of some model has no profile for this build. Recut with
// machine-learning/scripts/recut_desktop_catalogue.py.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { join, relative, sep } = path;
const server = join(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = join(server, '..', 'machine-learning', 'frameleaf_ml');
const walk = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)],
  );
// Python sorts paths part by part (directory names before what is in them), not as whole strings.
const byPathParts = (a, b) => {
  const [left, right] = [a.split(sep), b.split(sep)];
  const index = left.findIndex((part, at) => part !== right[at]);
  if (index === -1) {
    return left.length - right.length;
  }
  return index >= right.length || left[index] > right[index] ? 1 : -1;
};
// The same files, in the same order, as preprocessing_identity(): models/**/*.py sorted, then four files.
const files = [
  ...walk(join(root, 'models'))
    .filter((file) => file.endsWith('.py'))
    .toSorted(byPathParts),
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
// Each smart-search request of each model, and whether some revision of it is this build.
const requests = new Map();
for (const profile of catalogue.profiles) {
  if (profile.workload !== 'clip') {
    continue;
  }
  const request = `${profile.modelName} ${JSON.stringify(profile.spec.entries.clip)}`;
  requests.set(request, requests.get(request) || profile.spec.preprocessingSha256 === identity);
}
const missing = [...requests].filter(([, served]) => !served).map(([request]) => request);
if (missing.length === 0) {
  console.log(
    `machine-learning ${identity.slice(0, 12)} has a catalogue profile for all ${requests.size} smart-search requests`,
  );
} else {
  console.error(
    `machine-learning ${identity.slice(0, 12)} has no catalogue profile for ${missing.length} of ${requests.size} ` +
      `smart-search requests:\n${missing.map((request) => `  ${request}`).join('\n')}\n` +
      'Once a desktop is granted smart search with one of these models, this server would refuse every\n' +
      'catalogue identity for it: its own photo embedding and searching by words would fail.\n' +
      'Recut the catalogue: machine-learning/scripts/recut_desktop_catalogue.py.',
  );
  process.exitCode = 1;
}
