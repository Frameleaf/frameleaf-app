import { Injectable } from '@nestjs/common';
import { fork } from 'node:child_process';
import { dirname, join } from 'node:path';
import { IMMICH_SERVER_START } from 'src/constants.js';

/**
 * The environment of the throwaway API server the health check starts. FL-294: the deprecated
 * IMMICH_HOST and IMMICH_PORT are dropped, since an old-name port would conflict with the one set here.
 */
export const healthCheckEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const { IMMICH_HOST: _host, IMMICH_PORT: _port, ...rest } = env;
  return { ...rest, FRAMELEAF_HOST: '127.0.0.1', FRAMELEAF_PORT: '33001' };
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

      worker.stdout?.on('data', (data) => {
        if (worker.exitCode !== null) {
          return;
        }

        output += data;

        if (output.includes(IMMICH_SERVER_START)) {
          resolve();
          worker.kill('SIGTERM');
        }
      });

      worker.on('exit', (code, signal) =>
        reject(new Error(`Server health check failed, server exited with ${signal ?? code}`)),
      );
      worker.on('error', (error) => reject(new Error(`Server health check failed, process threw: ${error}`)));

      setTimeout(() => {
        if (worker.exitCode !== null) {
          return;
        }

        reject(new Error('Server health check failed, took too long to start.'));
        worker.kill('SIGTERM');
      }, 180_000);
    });
  }
}
