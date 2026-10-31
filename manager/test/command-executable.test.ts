import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { command } from '../src/docker.js';

test('fixed executables bypass PATH and preserve literal arguments and input', async () => {
  const argument = 'spaces ; $(not-a-command) "quotes"';
  const output = await command('restic', ['-e',
    'let input="";process.stdin.on("data",v=>input+=v);process.stdin.on("end",()=>process.stdout.write(JSON.stringify({args:process.argv.slice(1),input})))',
    argument], { executable: process.execPath, input: 'synthetic input', env: { PATH: '' }, timeout: 5000 });
  assert.deepEqual(JSON.parse(output), { args: [argument], input: 'synthetic input' });
});

test('fixed executables preserve logical error codes and discard private stderr', async () => {
  await assert.rejects(
    command('restic', ['-e', 'process.stderr.write("synthetic private credential");process.exit(31)'],
      { executable: process.execPath, timeout: 5000 }),
    { message: 'restic_operation_failed' },
  );
  await assert.rejects(
    command('restic', [], { executable: join(tmpdir(), 'missing-engine', 'restic'), timeout: 5000 }),
    { message: 'restic_unavailable' },
  );
});

test('invalid fixed executables are refused before partial output is removed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-fixed-command-'));
  const outputFile = join(directory, 'output');
  try {
    for (const executable of ['', 'restic', './restic', join(directory, 'sub') + '/../restic', process.execPath + '\0']) {
      await writeFile(outputFile + '.partial', 'preserve this fixture');
      await assert.rejects(command('restic', [], { executable, outputFile, timeout: 5000 }),
        { message: 'command_executable_invalid' });
      assert.equal(await readFile(outputFile + '.partial', 'utf8'), 'preserve this fixture');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('fixed executables retain atomic output transfer and failure cleanup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-fixed-transfer-'));
  const outputFile = join(directory, 'output');
  try {
    await command('restic', ['-e', 'process.stdout.write("complete fixture")'],
      { executable: process.execPath, outputFile, timeout: 5000 });
    assert.equal(await readFile(outputFile, 'utf8'), 'complete fixture');
    await assert.rejects(command('restic', ['-e', 'process.stdout.write("incomplete");process.exit(1)'],
      { executable: process.execPath, outputFile, timeout: 5000 }), { message: 'restic_operation_failed' });
    assert.equal(await readFile(outputFile, 'utf8'), 'complete fixture');
    await assert.rejects(readFile(outputFile + '.partial'), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
