import { CloudMlConnection, MlWorkload, type CloudMlStatusResponseDto } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import {
  cloudConnectionHelpKey,
  cloudConnectionLabelKey,
  cloudConsentNeeded,
  cloudHistory,
  cloudWorkloads,
  formatUnitPrice,
  modelsFor,
  walletDailyCapReached,
  walletIsEmpty,
} from '$lib/frameleaf/cloud-ml';

const consent = (acceptedVersion: string | null, outdated = false) => ({
  requiredVersion: '2026-10-01',
  recordedVersion: acceptedVersion,
  acceptedVersion,
  features: { identityNames: false, medicalSignals: false, ocrAddon: false },
  summary: 'Media is processed in the EU region.',
  documentUrl: null,
  outdated,
});

const status = (overrides: Partial<CloudMlStatusResponseDto>) =>
  ({ destination: { consent: { acknowledgedAt: null } }, consent: null, ...overrides }) as CloudMlStatusResponseDto;

describe('Frameleaf Cloud presentation rules (FL-159)', () => {
  it('labels every connection state and explains every state that is not ready', () => {
    for (const connection of Object.values(CloudMlConnection)) {
      expect(cloudConnectionLabelKey(connection)).toMatch(/^admin\.frameleaf_cloud_ml_connection_/);
      expect(cloudConnectionHelpKey(connection) === null).toBe(connection === CloudMlConnection.Ready);
    }
  });

  it('asks for consent until the current version is accepted', () => {
    expect(cloudConsentNeeded(status({ destination: null }))).toBe(false);
    expect(cloudConsentNeeded(status({ consent: consent(null) }))).toBe(true);
    expect(cloudConsentNeeded(status({ consent: consent('2026-09-25', true) }))).toBe(true);
    expect(cloudConsentNeeded(status({ consent: consent('2026-10-01') }))).toBe(false);
    // Without an answer from the cloud, the destination's own record decides.
    expect(cloudConsentNeeded(status({}))).toBe(true);
  });

  it('reads an empty wallet and a used-up daily limit from what the cloud reported', () => {
    expect(walletIsEmpty({ availableUsd: 0 })).toBe(true);
    expect(walletIsEmpty({ availableUsd: 0.01 })).toBe(false);
    expect(walletDailyCapReached({ dailyCapUsd: null, spentTodayUsd: 99 })).toBe(false);
    expect(walletDailyCapReached({ dailyCapUsd: 5, spentTodayUsd: 5 })).toBe(true);
  });

  it('offers only the work Frameleaf Cloud may run, never faces, search or text recognition', () => {
    expect(cloudWorkloads()).not.toContain(MlWorkload.Face);
    expect(cloudWorkloads()).not.toContain(MlWorkload.Clip);
    expect(cloudWorkloads()).not.toContain(MlWorkload.Ocr);
    expect(cloudWorkloads()).toContain(MlWorkload.Enrichment);
    expect(cloudWorkloads()).toContain(MlWorkload.Upscale);
  });

  it('keeps fractions of a cent in a per-unit price', () => {
    expect(formatUnitPrice(0.002, 'en-US')).toBe('$0.002');
    expect(formatUnitPrice(1.5, 'en-US')).toBe('$1.50');
  });

  it("lists the catalogue's models for one workload", () => {
    const models = [
      { id: 'a', workload: MlWorkload.Enrichment },
      { id: 'b', workload: MlWorkload.Upscale },
      { id: 'c', workload: null },
    ] as never;
    expect(modelsFor(models, MlWorkload.Enrichment).map(({ id }) => id)).toEqual(['a']);
  });

  it('merges consent records and settled charges, newest first', () => {
    const history = cloudHistory(
      [
        {
          version: '2026-09-25',
          features: { identityNames: true, medicalSignals: false, ocrAddon: false },
          acceptedBy: 'admin',
          acceptedAt: '2026-09-25T08:00:00.000Z',
          revokedAt: '2026-09-25T12:00:00.000Z',
        },
      ],
      [
        {
          cloudJobId: 'job-1',
          workload: MlWorkload.Enrichment,
          jobName: 'ImageDescription',
          succeeded: true,
          costUsd: 0.42,
          credits: 42,
          finishedAt: '2026-09-25T10:00:00.000Z',
        },
      ],
    );
    expect(history.map(({ kind }) => kind)).toEqual(['revoked', 'settlement', 'consent']);
  });
});
