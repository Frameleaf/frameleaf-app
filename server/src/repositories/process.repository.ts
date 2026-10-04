import { Injectable } from '@nestjs/common';
import { SpawnOptionsWithoutStdio, fork, spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import { parentPort } from 'node:worker_threads';
import { advanceJobProgress, jobSignal } from 'src/queue/context.js';

@Injectable()
export class ProcessRepository {
  spawn = spawn;

  /**
   * A child process as a duplex stream: writes go to its stdin, its stdout is read. The stream ends only
   * once the child has exited 0 having read all of its input; otherwise it fails with what went wrong and
   * the child's stderr.
   *
   * FL-298: a non-zero exit, a signal, or a child that stops reading its input while there is more of it
   * (Apple gzip prints its usage and exits 0 on an option it does not know) each fail the stream, so a
   * pipeline through it never looks finished when the child produced a partial or empty result.
   */
  spawnDuplexStream(command: string, args?: readonly string[], options?: SpawnOptionsWithoutStdio): Duplex {
    // the child has exited and closed its stdio
    let isClosed = false;
    // the child closed its stdin while input remained (EPIPE); the rest is dropped and the stream fails
    let isInputLost = false;
    // every input chunk was handed over and stdin is being ended; a clean exit before this lost input
    let isInputEnded = false;
    // something writes to this stream (it is piped into, or written to); output-only use has no input to lose
    let hasInput = false;
    let drainCallback: undefined | ((error?: Error | null) => void);
    let stderr = '';

    const signal = options?.signal ?? jobSignal();
    const process = this.spawn(command, args, { ...options, signal });
    if (process.pid) parentPort?.postMessage({ type: 'queue-child', pid: process.pid, active: true });
    const lostInputError = () => new Error(`${command} exited before reading all of its input\n${stderr}`);

    const releaseWrite = () => {
      const callback = drainCallback;
      drainCallback = undefined;
      process.stdin.off('drain', releaseWrite);
      callback?.();
    };

    const duplex = new Duplex({
      // duplex -> stdin
      write(chunk, encoding, callback) {
        hasInput = true;
        if (isClosed) {
          // the child is gone and there is more input: whatever it produced is incomplete
          return callback(lostInputError());
        }

        if (isInputLost) {
          // the child stopped reading; drop the input until it exits, which decides the error
          return callback();
        }

        // handle stream backpressure
        if (process.stdin.write(chunk, encoding)) {
          callback();
        } else {
          drainCallback = callback;
          process.stdin.once('drain', releaseWrite);
        }
      },

      read() {
        // no-op
      },

      final(callback) {
        isInputEnded = true;
        if (isClosed || isInputLost) {
          callback();
        } else {
          process.stdin.end(callback);
        }
      },

      destroy(error, callback) {
        if (isClosed) return callback(error);
        // Do not give a queue claim back while its subprocess can still publish output.
        const terminate = setTimeout(() => process.kill('SIGKILL'), 10_000);
        terminate.unref();
        process.once('close', () => {
          clearTimeout(terminate);
          callback(error);
        });
        process.kill('SIGTERM');
      },
    });

    const fail = (error: Error) => {
      if (!duplex.destroyed) {
        duplex.destroy(error);
      }
    };

    // stdout -> duplex
    process.stdout.on('data', (chunk) => {
      advanceJobProgress(chunk.byteLength);
      // handle stream backpressure
      if (!duplex.push(chunk)) {
        process.stdout.pause();
      }
    });

    duplex.on('resume', () => process.stdout.resume());
    duplex.on('pipe', () => (hasInput = true));

    // error handling
    process.on('error', fail);
    process.stdout.on('error', fail);
    process.stdin.on('error', (error) => {
      if ((error as { code?: string })?.code === 'EPIPE') {
        isInputLost = true;
        releaseWrite();
      } else {
        fail(error);
      }
    });

    process.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-65_536);
    });

    // end handling: 'close' comes after the exit and once stdout and stderr are fully read
    process.on('close', (code, signal) => {
      isClosed = true;
      if (process.pid) parentPort?.postMessage({ type: 'queue-child', pid: process.pid, active: false });
      console.info(`${command} exited (${code ?? signal})`);

      // FL-298: a write still waiting for 'drain' never gets one now; on Linux a child that exits before
      // reading can leave it waiting without any EPIPE, so input it never read must count as lost
      const pendingWrite = drainCallback;
      drainCallback = undefined;
      process.stdin.off('drain', releaseWrite);
      const isInputUnread = isInputLost || pendingWrite !== undefined || (hasInput && !isInputEnded);

      let error: Error | undefined;
      if (signal) {
        error = new Error(`${command} was stopped by signal ${signal}\n${stderr}`);
      } else if (code !== 0) {
        error = new Error(`${command} non-zero exit code (${code})\n${stderr}`);
      } else if (isInputUnread) {
        error = lostInputError();
      }

      if (error) {
        // release the waiting write with the failure, so the pipeline rejects instead of hanging
        pendingWrite?.(error);
        fail(error);
      } else {
        pendingWrite?.();
        duplex.push(null);
      }
    });

    return Object.assign(duplex, { _process: process });
  }

  fork(...args: Parameters<typeof fork>): ReturnType<typeof fork> {
    return fork(...args);
  }
}
