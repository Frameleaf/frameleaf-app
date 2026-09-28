import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CATALOGUE_PATH,
  MANIFEST_PATH,
  SERVER_MIRROR_PATH,
  WEB_VOCABULARY_PATH,
  buildServerMirror,
  canonicalJson,
  generate,
  parseWebVocabulary,
  validate,
} from './frameleaf-studio-commands.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const read = (file) => readFile(path.join(repository, file), 'utf8');
const clone = (value) => JSON.parse(JSON.stringify(value));

const inputs = async () => ({
  manifest: JSON.parse(await read(MANIFEST_PATH)),
  webSource: await read(WEB_VOCABULARY_PATH),
});

/** The real inputs must validate, and the checked-in artifacts must already match. */
test('the published catalogue and its generated contracts are current', async () => {
  const { document, files } = await generate(repository);

  assert.equal(document.schemaVersion, 1);
  assert.equal(document.engineRevision, '4d62e8082c5eb387a96275bcbd323d28f6e41a62');
  assert.equal(document.counts.commands, document.commands.length);
  assert.equal(
    document.counts.manifestRowsMapped + document.counts.manifestRowsDeclaredNonCommand,
    document.counts.manifestRows,
    'every pinned feature row is either reachable through a command or declared a non-command row',
  );

  for (const [file, content] of Object.entries(files)) {
    assert.equal(await read(file), content, `${file} is stale; run the generator with --write`);
  }
  assert.deepEqual(Object.keys(files).sort(), [CATALOGUE_PATH, SERVER_MIRROR_PATH].sort());
});

test('the published contracts omit private planning metadata', async () => {
  const { document, files } = await generate(repository);

  assert.equal(Object.hasOwn(document, 'prototypePath'), false);
  assert.equal(Object.hasOwn(document, 'status'), false);
  for (const command of document.commands) {
    assert.deepEqual(Object.keys(command).sort(), [
      'capability',
      'description',
      'id',
      'manifestIds',
      'mutatesGraph',
      'payload',
      'scope',
      'undoable',
    ]);
  }
  for (const row of document.nonCommandRows) {
    assert.deepEqual(Object.keys(row).sort(), ['id', 'reason']);
  }
  for (const content of [...Object.values(files), await read(WEB_VOCABULARY_PATH)]) {
    assert.doesNotMatch(content, /FL-\d+|prototypeFunctions|prototypeSource|owner:/);
  }
});

test('a manifest row that loses its command and its exemption fails the check', async () => {
  const { document } = await generate(repository);
  const context = await inputs();
  const broken = clone(document);
  const victim = broken.commands.find((command) => command.id === 'clip.split');
  victim.manifestIds = [];

  assert.throws(
    () => validate({ document: broken, ...context }),
    /command\.split has no command and is not declared a non-command row/,
  );
});

test('a job row may not claim a graph change, an undo entry or a missing worker', async () => {
  const { document } = await generate(repository);
  const context = await inputs();

  for (const [patch, pattern] of [
    [{ mutatesGraph: true }, /not a graph change/],
    [{ undoable: true }, /only a graph change can be undoable/],
    [{ capability: null }, /must name the worker it needs/],
  ]) {
    const broken = clone(document);
    const job = broken.commands.find((command) => command.id === 'job.enqueueExport');
    Object.assign(job, patch);
    assert.throws(() => validate({ document: broken, ...context }), pattern);
  }
});

test('a web vocabulary that drifts from the catalogue fails the check', async () => {
  const { document } = await generate(repository);
  const context = await inputs();

  assert.throws(
    () => validate({ document, ...context, webSource: context.webSource.replace("'clip.split',", "'clip.chop',") }),
    /Web command ids drifted/,
  );
});

test('the web vocabulary parser reads the file this repository actually has', async () => {
  const web = parseWebVocabulary(await read(WEB_VOCABULARY_PATH));
  const { document } = await generate(repository);

  assert.equal(web.ids.length, document.counts.commands);
  assert.equal(web.rows.length, document.counts.commands);
  assert.equal(web.payloadKeys.length, document.counts.commands);
});

test('the server mirror describes every command', async () => {
  const { document } = await generate(repository);
  const mirror = buildServerMirror(document);

  for (const command of document.commands) {
    assert.ok(mirror.includes(`'${command.id}': {`), `${command.id} missing from the server mirror`);
    for (const [name, declared] of Object.entries(command.payload)) {
      assert.ok(mirror.includes(`${name}: '${declared}',`), `${command.id}.${name} missing from the server mirror`);
    }
  }
});

test('the catalogue is serialized the way the repository formats JSON', () => {
  assert.equal(canonicalJson({ b: 1, a: [1, 2] }), '{\n  "a": [1, 2],\n  "b": 1\n}\n');
  assert.equal(canonicalJson({ a: {} }), '{\n  "a": {}\n}\n');
});
