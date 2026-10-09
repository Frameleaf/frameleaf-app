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
import { COMMAND_AXIS_WAIVERS } from '../studio/tools/conformance.mjs';

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
    assert.deepEqual(
      Object.keys(row).sort(),
      row.commands.length > 0 ? ['commands', 'id', 'reason'] : ['commands', 'id', 'reason', 'withoutCommand'],
    );
  }
  for (const content of [...Object.values(files), await read(WEB_VOCABULARY_PATH)]) {
    assert.doesNotMatch(content, /FL-\d+|prototypeFunctions|prototypeSource|owner:/);
  }
});

test('the generator retains the accepted optional master gain envelope', async () => {
  const { document } = await generate(repository);
  const master = document.commands.find((command) => command.id === 'project.setMasterAudio');

  assert.deepEqual(master.payload, {
    gainDb: 'number?',
    muted: 'boolean?',
    ducking: 'boolean?',
    gainEnvelope: 'Array<{id:string,at:Rational,gainDb:number}>?',
  });
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

test('every non-command row names the commands that prove it, or says what does instead', async () => {
  const { document } = await generate(repository);
  const linked = document.nonCommandRows.filter((row) => row.commands.length > 0);

  assert.equal(linked.length, 16);
  assert.equal(document.counts.nonCommandRowsLinkedToCommands, 16);
  const commandsOf = (id) => document.nonCommandRows.find((row) => row.id === id).commands;
  assert.deepEqual(commandsOf('module.effects'), ['effect.add', 'effect.remove', 'effect.reorder', 'effect.update']);
  assert.deepEqual(commandsOf('readme.effects-masks-compositing.8'), ['clip.update', 'effect.update']);

  // A row with no command is one the coordinator waived on the command axis, or the one row
  // measured on the server's project service instead of through an editor command.
  assert.deepEqual(
    document.nonCommandRows.filter((row) => row.commands.length === 0).map((row) => row.id),
    [...COMMAND_AXIS_WAIVERS.keys(), 'readme.projects-storage.4'].sort(),
  );
});

test('a non-command row with no link, an unknown command or a contradictory link fails the check', async () => {
  const { document } = await generate(repository);
  const context = await inputs();
  const row = (broken, id) => broken.nonCommandRows.find((entry) => entry.id === id);

  for (const [mutate, pattern] of [
    [
      (broken) => (row(broken, 'module.effects').commands = []),
      /module\.effects is linked to no command and does not say what covers it instead/,
    ],
    [(broken) => delete row(broken, 'module.effects').commands, /module\.effects needs a commands list/],
    [
      (broken) => delete row(broken, 'module.docs').withoutCommand,
      /module\.docs is linked to no command and does not say what covers it instead/,
    ],
    [
      (broken) => row(broken, 'module.effects').commands.push('effect.polish'),
      /module\.effects is linked to unknown command effect\.polish/,
    ],
    [
      (broken) => row(broken, 'module.effects').commands.push('effect.add'),
      /module\.effects names a command twice/,
    ],
    [
      (broken) => (row(broken, 'module.effects').withoutCommand = 'none'),
      /module\.effects is linked to a command and also claims to have none/,
    ],
  ]) {
    const broken = clone(document);
    mutate(broken);
    assert.throws(() => validate({ document: broken, ...context }), pattern);
  }
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
