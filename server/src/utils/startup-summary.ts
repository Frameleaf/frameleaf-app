import type { DatabaseConnectionParams } from '@frameleaf/sql-tools';

/** `host:port/database`, never a username or password (a `DB_URL` can carry both). */
export const describeDatabase = (config: DatabaseConnectionParams) => {
  if (config.connectionType === 'parts') {
    return `${config.host}:${config.port}/${config.database}`;
  }
  try {
    const url = new URL(config.url);
    return `${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname}`;
  } catch {
    return '(DB_URL)';
  }
};

/** An address with any user, password, query and fragment removed. */
export const describeUrl = (value: string) => {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return '(invalid address)';
  }
};

export type StartupFacts = {
  worker?: string;
  version: string;
  database: DatabaseConnectionParams;
  postgresVersion: string;
  mediaLocation: string;
  importRoots: string[];
  machineLearning: { enabled: boolean; urls: string[] };
  port: number;
};

/** The lines each worker prints at startup, so `docker logs` answers "what is this server using?". */
export const startupSummary = (facts: StartupFacts) => [
  `Worker: ${facts.worker ?? 'unknown'} (v${facts.version})`,
  `Database: ${describeDatabase(facts.database)} (PostgreSQL ${facts.postgresVersion})`,
  `Media: ${facts.mediaLocation}`,
  ...(facts.importRoots.length > 0 ? [`Import folders: ${facts.importRoots.join(', ')}`] : []),
  `Machine learning: ${facts.machineLearning.enabled ? `on (${facts.machineLearning.urls.map((url) => describeUrl(url)).join(', ')})` : 'off'}`,
  `Port: ${facts.port}`,
];
