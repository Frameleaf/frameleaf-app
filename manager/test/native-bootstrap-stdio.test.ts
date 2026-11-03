import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

test('native bootstrap input survives EOF without violating Node pipe ownership', async () => {
  const text = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const source = ts.createSourceFile('main.ts', text, ts.ScriptTarget.Latest, true);
  const inputs: ts.Expression[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'createNativeService') {
      inputs.push(node.arguments[1]);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(inputs.length, 1);
  const directory = await mkdtemp(join(tmpdir(), 'frameleaf-bootstrap-stdio-'));
  try {
    // Exercise the real caller stream through EOF and explicit destruction in a child process.
    const script = `
      import {createReadStream, fstatSync} from 'node:fs';
      const input = ${inputs[0].getText(source)};
      console.log('bootstrap-reading');
      for await (const chunk of input) {}
      const closed = new Promise(resolve => input.closed ? resolve() : input.once('close', resolve));
      input.destroy();
      await closed;
      fstatSync(0);
      console.log('bootstrap-ended');
    `;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '', TMPDIR: directory, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    });
    let stdout = '', stderr = '', inputClosed = false;
    const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    child.stdin.on('error', () => {});
    child.stdout.on('data', bytes => {
      stdout += bytes;
      if (!inputClosed && stdout.includes('bootstrap-reading\n')) {
        inputClosed = true;
        child.stdin.end();
      }
      if (stdout.length > 64 * 1024) child.kill('SIGKILL');
    });
    child.stderr.on('data', bytes => {
      stderr += bytes;
      if (stderr.length > 64 * 1024) child.kill('SIGKILL');
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
    try {
      const result = await ended;
      assert.equal(result.signal, null, stderr);
      assert.equal(result.code, 0, stderr);
      assert.equal(stdout, 'bootstrap-reading\nbootstrap-ended\n');
    } finally {
      clearTimeout(timeout);
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await ended;
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
