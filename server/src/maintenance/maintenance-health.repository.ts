import { Injectable } from '@nestjs/common';
import { fork } from 'node:child_process';
import { dirname, join } from 'node:path';
import { IMMICH_SERVER_START } from 'src/constants.js';

/**
 * The environment of the throwaway API server the health check starts. FL-294: the deprecated
 * IMMICH_HOST and IMMICH_PORT are dropped, since an old-name port would conflict with the one set here.
 */
export const healthCheckEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const { IMMICH_HOST: _host, IMMICH_PORT: _port, IMMICH_LOG_LEVEL: _logLevel, ...rest } = env;
  // The child must emit its readiness marker even when the admin CLI keeps the parent quiet.
  return { ...rest, FRAMELEAF_HOST: '127.0.0.1', FRAMELEAF_PORT: '33001', FRAMELEAF_LOG_LEVEL: 'log' };
};

@Injectable()
export class MaintenanceHealthRepository {
  checkApiHealth(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const basePath = dirname(import.meta.filename);
      const workerFile = join(basePath, '..', 'workers', `api.js`);

      const worker = fork(workerFile, [], {
        execArgv: process.execArgv.filter((arg) => !arg.startsWith('--inspect')),
        env: healthCheckEnv(process.env),
        stdio: ['ignore', 'pipe', 'ignore', 'ipc'],
      });

      let output = '';
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        finish(new Error('Server health check failed, took too long to start.'));
        worker.kill('SIGTERM');
      }, 180_000);

      worker.stdout?.on('data', (data) => {
        if (settled || worker.exitCode !== null) {
          return;
        }

        output += data;

        if (output.includes(IMMICH_SERVER_START)) {
          finish();
          worker.kill('SIGTERM');
        }
        // Only this suffix can combine with the next chunk to complete the readiness marker.
        output = output.slice(-(IMMICH_SERVER_START.length - 1));
      });

      worker.on('exit', (code, signal) =>
        finish(new Error(`Server health check failed, server exited with ${signal ?? code}`)),
      );
      worker.on('error', (error) => finish(new Error(`Server health check failed, process threw: ${error}`)));
    });
  }
}
