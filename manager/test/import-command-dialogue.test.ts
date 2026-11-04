import assert from 'node:assert/strict';
import { test } from 'node:test';
import { command } from '../src/docker.js';
import { Refusal } from '../src/contracts.js';

const executable = process.execPath;
const timeout = 5000;

test('offline import dialogue handles fragmented lines and awaits each source check before replying', async () => {
  const seen: string[] = [];
  const output = await command(
    'docker',
    [
      '-e',
      `
    process.stdout.write('ready\\nauth');
    setTimeout(() => process.stdout.write('?\\n'), 10);
    let input = '';
    process.stdin.on('data', (value) => {
      input += value;
      if (input.includes('\\n')) {
        if (input !== 'approved\\n') process.exit(23);
        process.stdout.write('complete\\n');
        process.stdin.pause();
        process.stdin.unref();
      }
    });
  `,
    ],
    {
      executable,
      timeout,
      reply: async (line: string) => {
        seen.push(line);
        if (line !== 'auth?') return undefined;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return 'approved\n';
      },
    },
  );
  assert.equal(output, 'ready\nauth?\ncomplete\n');
  assert.deepEqual(seen, ['ready', 'auth?', 'complete']);
});

test('a failed source check terminates the child without logging private callback errors', async () => {
  const privateValue = 'synthetic-private-source-credential';
  const lines: unknown[][] = [];
  const previous = console.error;
  console.error = (...args) => lines.push(args);
  try {
    await assert.rejects(
      command('docker', ['-e', "process.stdout.write('auth?\\n');process.stdin.resume()"], {
        executable,
        timeout,
        reply: async () => {
          throw new Error(privateValue);
        },
      }),
      { message: 'command_reply_failed' },
    );
    assert(!JSON.stringify(lines).includes(privateValue));
  } finally {
    console.error = previous;
  }
});

test(
  'a child exiting during a pending source check cannot leave command recovery waiting',
  { timeout: 3000 },
  async () => {
    await assert.rejects(
      command('docker', ['-e', "process.stdout.write('auth?\\n');setTimeout(()=>process.exit(0),20)"], {
        executable,
        timeout,
        reply: () => new Promise<string>(() => {}),
      }),
      { message: 'command_reply_failed' },
    );
  },
);

test('dialogue cannot share input or file-transfer modes', async () => {
  for (const options of [{ input: '' }, { inputFile: '/never-read' }, { outputFile: '/never-write' }]) {
    await assert.rejects(
      command('docker', ['-e', 'process.exit(99)'], {
        executable,
        timeout,
        ...options,
        reply: async () => undefined,
      }),
      { message: 'command_dialogue_invalid' },
    );
  }
});

test('known source refusal keeps its code and status while discarding private details', async () => {
  const privateValue = 'synthetic-private-authority-detail';
  const lines: unknown[][] = [];
  const previous = console.error;
  console.error = (...args) => lines.push(args);
  try {
    await assert.rejects(
      command('docker', ['-e', "process.stdout.write('auth?\\n');process.stdin.resume()"], {
        executable,
        timeout,
        reply: async () => {
          throw new Refusal('import_source_authority_refused', 403, privateValue);
        },
      }),
      (error: unknown) => {
        assert(error instanceof Refusal);
        assert.equal(error.code, 'import_source_authority_refused');
        assert.equal(error.status, 403);
        assert.equal(error.detail, undefined);
        return true;
      },
    );
    assert(!JSON.stringify(lines).includes(privateValue));
  } finally {
    console.error = previous;
  }
});

test('unknown refusal codes and invalid status values remain generic and private', async () => {
  const privateValue = 'synthetic-private-authority-value';
  const lines: unknown[][] = [];
  const previous = console.error;
  console.error = (...args) => lines.push(args);
  try {
    for (const failure of [
      new Refusal(privateValue, 409, privateValue),
      new Refusal('import_source_authority_refused', 200, privateValue),
      new Refusal('import_source_authority_refused', privateValue as never, privateValue),
    ]) {
      await assert.rejects(
        command('docker', ['-e', "process.stdout.write('auth?\\n');process.stdin.resume()"], {
          executable,
          timeout,
          reply: async () => {
            throw failure;
          },
        }),
        { message: 'command_reply_failed' },
      );
    }
    assert(!JSON.stringify(lines).includes(privateValue));
  } finally {
    console.error = previous;
  }
});
