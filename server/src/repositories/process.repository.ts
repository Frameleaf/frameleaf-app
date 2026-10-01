import { Injectable } from '@nestjs/common';
import { SpawnOptionsWithoutStdio, fork, spawn } from 'node:child_process';
import { Duplex } from 'node:stream';

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
    let drainCallback: undefined | (() => void);
    let stderr = '';

    const process = this.spawn(command, args, options);
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
        if (isClosed || isInputLost) {
          callback();
        } else {
          process.stdin.end(callback);
        }
      },

      destroy(error, callback) {
        if (process.exitCode === null && process.signalCode === null) {
          process.kill();
        }
        callback(error);
      },
    });

    const fail = (error: Error) => {
      if (!duplex.destroyed) {
        duplex.destroy(error);
      }
    };

    // stdout -> duplex
    process.stdout.on('data', (chunk) => {
      // handle stream backpressure
      if (!duplex.push(chunk)) {
        process.stdout.pause();
      }
    });

    duplex.on('resume', () => process.stdout.resume());

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

    process.stderr.on('data', (chunk) => (stderr += chunk));

    // end handling: 'close' comes after the exit and once stdout and stderr are fully read
    process.on('close', (code, signal) => {
      isClosed = true;
      console.info(`${command} exited (${code ?? signal})`);

      if (signal) {
        fail(new Error(`${command} was stopped by signal ${signal}\n${stderr}`));
      } else if (code !== 0) {
        fail(new Error(`${command} non-zero exit code (${code})\n${stderr}`));
      } else if (isInputLost) {
        fail(lostInputError());
      } else {
        duplex.push(null);
      }
    });

    return Object.assign(duplex, { _process: process });
  }

  fork(...args: Parameters<typeof fork>): ReturnType<typeof fork> {
    return fork(...args);
  }
}
