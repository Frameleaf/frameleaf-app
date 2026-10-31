import type { Operation } from '../contracts.js';

/** Only the lifecycle surface shared by Docker and native Manager runtimes. */
export interface ManagerLifecycle {
  installation(): {
    id: string;
    name?: string;
    release: string;
    port: number;
  } | null;
  control(
    action: 'start' | 'stop' | 'restart' | 'backup',
    key: string,
    installationId?: string,
  ): Operation;
  resume(id: string): Operation;
}
