import { renderBanner } from 'src/utils/banner.js';
import { startupSummary } from 'src/utils/startup-summary.js';

describe('startup summary', () => {
  const facts = {
    worker: 'api',
    version: '1.2.4',
    database: {
      connectionType: 'url' as const,
      url: 'postgres://frameleaf:synthetic-db-password@db.lan:5433/library?sslmode=require',
    },
    postgresVersion: '19.1',
    mediaLocation: '/data',
    importRoots: [],
    machineLearning: {
      enabled: true,
      urls: ['http://user:synthetic-ml-password@frameleaf-machine-learning:3003/?token=x'],
    },
    port: 2283,
  };

  it('names the worker, database, media, machine learning and port without any credential', () => {
    const lines = startupSummary(facts);
    expect(lines).toEqual([
      'Worker: api (v1.2.4)',
      'Database: db.lan:5433/library (PostgreSQL 19.1)',
      'Media: /data',
      'Machine learning: on (http://frameleaf-machine-learning:3003)',
      'Port: 2283',
    ]);
    expect(lines.join('\n')).not.toContain('synthetic');
  });

  it('shows the parts connection and machine learning off', () => {
    const lines = startupSummary({
      ...facts,
      database: {
        connectionType: 'parts',
        host: 'database',
        port: 5432,
        username: 'postgres',
        password: 'pw',
        database: 'frameleaf',
      },
      importRoots: ['/import'],
      machineLearning: { enabled: false, urls: [] },
    });
    expect(lines).toContain('Database: database:5432/frameleaf (PostgreSQL 19.1)');
    expect(lines).toContain('Import folders: /import');
    expect(lines).toContain('Machine learning: off');
  });
});

describe('banner', () => {
  it('is plain ASCII, at most 10 lines by 60 columns, with the name and version', () => {
    const banner = renderBanner('Frameleaf', 'v1.2.4', { color: false });
    expect(banner.split('\n').length).toBeLessThanOrEqual(10);
    expect(Math.max(...banner.split('\n').map((line) => line.length))).toBeLessThanOrEqual(60);
    expect(banner).toMatch(/^[ -~\n]+$/);
    expect(banner).toContain('Frameleaf');
    expect(banner).toContain('v1.2.4');
  });
});
