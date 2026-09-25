import type { AdminConfigDto, QueueResponseDto, ServerAboutResponseDto, ServerFeaturesDto } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import { buildDiagnostics, diagnosticsFileName } from './diagnostics';

const config = {
  oauth: { clientSecret: 'oauth-secret', clientSecretConfigured: true, issuerUrl: 'https://id.example' },
  notifications: { smtp: { transport: { password: 'smtp-secret', passwordConfigured: true, host: 'mail' } } },
  machineLearning: { runpod: { apiKey: 'runpod-key', hfToken: 'hf-token' } },
  logging: { enabled: true, level: 'log' },
} as unknown as AdminConfigDto;

describe('buildDiagnostics (FL-71)', () => {
  const generatedAt = new Date('2026-09-25T10:20:30Z');
  const diagnostics = buildDiagnostics({
    generatedAt,
    about: { version: 'v3.2.0', licensed: false, sourceRef: 'main' } as ServerAboutResponseDto,
    version: { major: 3, minor: 2, patch: 0, prerelease: null },
    features: { search: true } as unknown as ServerFeaturesDto,
    storage: {
      diskSize: '1 TiB',
      diskUse: '1 GiB',
      diskAvailable: '1 TiB',
      diskSizeRaw: 100,
      diskUseRaw: 10,
      diskAvailableRaw: 90,
      diskUsagePercentage: 10,
    },
    queues: [
      { name: 'thumbnailGeneration', isPaused: false, statistics: { active: 1 } } as unknown as QueueResponseDto,
    ],
    config,
  });

  it('never carries a credential value', () => {
    const text = JSON.stringify(diagnostics);
    for (const secret of ['oauth-secret', 'smtp-secret', 'runpod-key', 'hf-token']) {
      expect(text).not.toContain(secret);
    }
    expect(diagnostics.settings.oauth.clientSecretConfigured).toBe(true);
  });

  it('describes the build, storage totals and queues', () => {
    expect(diagnostics).toMatchObject({
      kind: 'frameleaf-diagnostics',
      generatedAt: '2026-09-25T10:20:30.000Z',
      version: '3.2.0',
      build: { version: 'v3.2.0', sourceRef: 'main' },
      storage: { diskSizeRaw: 100, diskUseRaw: 10 },
      queues: [{ name: 'thumbnailGeneration', isPaused: false, statistics: { active: 1 } }],
    });
  });

  it('names the file after the time it was made', () => {
    expect(diagnosticsFileName(generatedAt)).toBe('frameleaf-diagnostics-2026-09-25T10-20-30.json');
  });
});
