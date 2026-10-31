import { ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ProcessRepository } from 'src/repositories/process.repository.js';

function* data() {
  yield 'Hello, world!';
}

describe(ProcessRepository.name, () => {
  let sut: ProcessRepository;
  let sink: Writable;

  beforeAll(() => {
    sut = new ProcessRepository();
  });

  beforeEach(() => {
    sink = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },

      final(callback) {
        callback();
      },
    });
  });

  describe('createSpawnDuplexStream', () => {
    it('should work (drain to stdout)', async () => {
      const process = sut.spawnDuplexStream('bash', ['-c', 'exit 0']);
      await pipeline(process, sink);
    });

    it('should throw on non-zero exit code', async () => {
      const process = sut.spawnDuplexStream('bash', ['-c', 'echo "error message" >&2; exit 1']);
      await expect(pipeline(process, sink)).rejects.toThrowErrorMatchingInlineSnapshot(`
        [Error: bash non-zero exit code (1)
        error message
        ]
      `);
    });

    it('should accept stdin / output stdout', async () => {
      let output = '';
      const sink = new Writable({
        write(chunk, _encoding, callback) {
          output += chunk;
          callback();
        },

        final(callback) {
          callback();
        },
      });

      const echoProcess = sut.spawnDuplexStream('cat');
      await pipeline(Readable.from(data()), echoProcess, sink);
      expect(output).toBe('Hello, world!');
    });

    it('should fail when the child exits 0 before reading all of its input (FL-298)', async () => {
      let resolve1: () => void;
      let resolve2: () => void;
      const promise1 = new Promise<void>((r) => (resolve1 = r));
      const promise2 = new Promise<void>((r) => (resolve2 = r));

      async function* data() {
        yield 'Hello, world!';
        await promise1;
        await promise2;
        yield 'Write after stdin close / process exit!';
      }

      const process = sut.spawnDuplexStream('bash', ['-c', 'exit 0']);

      const realProcess = (process as never as { _process: ChildProcessWithoutNullStreams })._process;
      realProcess.on('close', () => setImmediate(() => resolve1()));
      realProcess.stdin.on('close', () => setImmediate(() => resolve2()));

      await expect(pipeline(Readable.from(data()), process, sink)).rejects.toThrow(
        'bash exited before reading all of its input',
      );
    });

    it('should fail like a compressor that rejects its options and exits 0 (FL-298)', async () => {
      // Apple gzip prints its usage and exits 0 on an unknown option such as --rsyncable
      const chunk = Buffer.alloc(64 * 1024, 'x');
      async function* dump() {
        for (let index = 0; index < 64; index++) {
          await new Promise((resolve) => setImmediate(resolve));
          yield chunk;
        }
      }

      const compressor = sut.spawnDuplexStream('bash', ['-c', 'echo "unrecognized option --rsyncable" >&2; exit 0']);

      await expect(pipeline(Readable.from(dump()), compressor, sink)).rejects.toThrow(
        /bash exited before reading all of its input\nunrecognized option --rsyncable/,
      );
    });

    it('should fail when the child is stopped by a signal (FL-298)', async () => {
      const process = sut.spawnDuplexStream('bash', ['-c', 'echo partial; echo "terminated" >&2; kill -TERM $$']);
      await expect(pipeline(process, sink)).rejects.toThrow(/bash was stopped by signal SIGTERM\nterminated/);
    });

    it('should fail when the child fails after closing its output (FL-298)', async () => {
      const process = sut.spawnDuplexStream('bash', ['-c', 'exec >&-; sleep 0.2; echo "late failure" >&2; exit 3']);
      await expect(pipeline(process, sink)).rejects.toThrow(/bash non-zero exit code \(3\)\nlate failure/);
    });

    it('should report the exit code, not lost input, when a failing child stops reading (FL-298)', async () => {
      const chunk = Buffer.alloc(64 * 1024, 'x');
      async function* dump() {
        for (let index = 0; index < 64; index++) {
          await new Promise((resolve) => setImmediate(resolve));
          yield chunk;
        }
      }

      const compressor = sut.spawnDuplexStream('bash', ['-c', 'echo "bad option" >&2; exit 1']);

      await expect(pipeline(Readable.from(dump()), compressor, sink)).rejects.toThrow(
        /bash non-zero exit code \(1\)\nbad option/,
      );
    });

    it('should pass the whole stream through a child that reads all of its input', async () => {
      const chunk = Buffer.alloc(64 * 1024, 'x');
      let output = 0;
      const counter = new Writable({
        write(data: Buffer, _encoding, callback) {
          output += data.length;
          callback();
        },
      });

      await pipeline(Readable.from(Array.from({ length: 64 }, () => chunk)), sut.spawnDuplexStream('cat'), counter);

      expect(output).toBe(64 * chunk.length);
    });

    it('should kill the child process when the stream is destroyed', async () => {
      const process = sut.spawnDuplexStream('bash', ['-c', 'sleep 60']);
      const realProcess = (process as never as { _process: ChildProcessWithoutNullStreams })._process;

      expect(realProcess.exitCode).toBeNull();

      const exited = new Promise<void>((resolve) => realProcess.once('exit', () => resolve()));
      process.destroy();
      await exited;

      expect(realProcess.killed).toBe(true);
    });

    it('should kill the child when pipeline tears the stream down after a failure', async () => {
      const process = sut.spawnDuplexStream('yes');
      const realProcess = (process as never as { _process: ChildProcessWithoutNullStreams })._process;
      const failingSink = new Writable({
        write(_chunk, _encoding, callback) {
          callback(new Error('sink exploded'));
        },
      });

      const exited = new Promise<void>((resolve) => realProcess.once('exit', () => resolve()));
      await expect(pipeline(process, failingSink)).rejects.toThrow('sink exploded');
      await exited;

      expect(realProcess.killed).toBe(true);
    });
  });
});
