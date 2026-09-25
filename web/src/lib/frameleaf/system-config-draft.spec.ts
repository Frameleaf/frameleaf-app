import type { AdminConfigDto } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import {
  configPathLabel,
  createJournal,
  diffConfig,
  importConfig,
  isJournalSafe,
  parseJournal,
  pickConfigKeys,
  rebaseDraft,
  recoverJournal,
  redactConfigForExport,
  resetConfigKeys,
  reviewValue,
  sectionForConfigPath,
  stripUrlCredentials,
  urlHasCredentials,
} from '$lib/frameleaf/system-config-draft';
import {
  adminConfigFixture as configFixture,
  adminConfigWith as withChange,
} from '@test-data/factories/admin-config-factory';

describe('diffConfig (FL-66)', () => {
  it('lists every changed leaf with the saved value and the draft value', () => {
    const draft = withChange((config) => {
      config.trash.days = 10;
      config.ffmpeg.acceptedVideoCodecs = ['h264', 'hevc'] as never;
    });

    expect(diffConfig(configFixture(), draft)).toEqual([
      { path: 'trash.days', before: 30, after: 10 },
      { path: 'ffmpeg.acceptedVideoCodecs', before: ['h264'], after: ['h264', 'hevc'] },
    ]);
  });

  it('never reports values the server keeps on its own', () => {
    const draft = withChange((config) => {
      config.machineLearning.imageDescription!.pendingRequeueAt = '2026-09-23T10:00:00.000Z';
      config.machineLearning.runpod!.apiKeyConfigured = false;
    });

    expect(diffConfig(configFixture(), draft)).toEqual([]);
  });

  it('maps a changed setting to the settings page that edits it', () => {
    expect(sectionForConfigPath('trash.days')).toBe('trash');
    expect(sectionForConfigPath('oauth.clientSecret')).toBe('authentication');
    expect(sectionForConfigPath('reverseGeocoding.enabled')).toBe('location');
    expect(sectionForConfigPath('localFeatures.askSearch.enabled')).toBe('machine-learning');
    expect(sectionForConfigPath('analytics.historyDays')).toBe('logging');
    expect(sectionForConfigPath('unknownGroup.anything')).toBeUndefined();
  });
});

describe('rebaseDraft (FL-66 concurrent administrators)', () => {
  it('carries changes that do not overlap onto the newer saved settings', () => {
    const baseline = configFixture();
    const draft = withChange((config) => (config.trash.days = 10));
    const latest = withChange((config) => (config.ffmpeg.crf = 30));

    const { draft: rebased, conflicts } = rebaseDraft(baseline, draft, latest);

    expect(conflicts).toEqual([]);
    expect(rebased.trash.days).toBe(10);
    expect(rebased.ffmpeg.crf).toBe(30);
  });

  it('names a setting both administrators changed to different values and leaves it out', () => {
    const baseline = configFixture();
    const draft = withChange((config) => (config.trash.days = 10));
    const latest = withChange((config) => (config.trash.days = 60));

    const { draft: rebased, conflicts } = rebaseDraft(baseline, draft, latest);

    expect(conflicts).toEqual([{ path: 'trash.days', before: 30, mine: 10, theirs: 60 }]);
    expect(rebased.trash.days).toBe(60);
  });

  it('is not a conflict when both administrators chose the same value', () => {
    const draft = withChange((config) => (config.trash.days = 10));
    const latest = withChange((config) => (config.trash.days = 10));

    expect(rebaseDraft(configFixture(), draft, latest).conflicts).toEqual([]);
  });

  it("applies the draft's values over conflicts once the administrator chooses to keep them", () => {
    const draft = withChange((config) => (config.trash.days = 10));
    const latest = withChange((config) => (config.trash.days = 60));

    const { draft: rebased, conflicts } = rebaseDraft(configFixture(), draft, latest, { force: true });

    expect(conflicts).toHaveLength(1);
    expect(rebased.trash.days).toBe(10);
  });

  it('takes the values the server keeps on its own from the newer settings', () => {
    const draft = withChange((config) => (config.trash.days = 10));
    const latest = withChange(
      (config) => (config.machineLearning.imageDescription!.pendingRequeueAt = '2026-09-23T10:00:00.000Z'),
    );

    const { draft: rebased } = rebaseDraft(configFixture(), draft, latest);

    expect(rebased.machineLearning.imageDescription!.pendingRequeueAt).toBe('2026-09-23T10:00:00.000Z');
  });
});

describe('page and partial saves (FL-66)', () => {
  it('"Reset this page" puts only that page\'s defaults into the draft', () => {
    const defaults = withChange((config) => {
      config.trash.days = 30;
      config.ffmpeg.crf = 23;
    });
    const draft = withChange((config) => {
      config.trash.days = 5;
      config.ffmpeg.crf = 40;
    });

    const reset = resetConfigKeys(draft, defaults, ['trash']);

    expect(reset.trash.days).toBe(30);
    expect(reset.ffmpeg.crf).toBe(40);
  });

  it('a partial save takes only the named groups from the draft', () => {
    const draft = withChange((config) => {
      config.trash.days = 5;
      config.notifications.smtp.enabled = true;
    });

    const payload = pickConfigKeys(configFixture(), draft, ['notifications']);

    expect(payload.notifications.smtp.enabled).toBe(true);
    expect(payload.trash.days).toBe(30);
  });
});

describe('credentials never leave the page (FL-66)', () => {
  it('recognises credentials inside URLs', () => {
    expect(urlHasCredentials('https://tiles.example.com/style.json?key=abc')).toBe(true);
    expect(urlHasCredentials('https://user:pass@example.com')).toBe(true);
    expect(urlHasCredentials('https://tiles.example.com/style.json?lang=en')).toBe(false);
    expect(urlHasCredentials('not a url')).toBe(false);
  });

  it('removes user names, passwords and key-like parameters from URLs', () => {
    expect(stripUrlCredentials('https://tiles.example.com/style.json?key=abc&lang=en')).toBe(
      'https://tiles.example.com/style.json?lang=en',
    );
    expect(stripUrlCredentials('https://user:pass@photos.example.com')).toBe('https://photos.example.com');
    expect(stripUrlCredentials('plain text')).toBe('plain text');
  });

  it('exports the saved settings without secrets, URL credentials, server bookkeeping or the revision', () => {
    const exported = redactConfigForExport({ ...configFixture(), revision: 'abc' } as AdminConfigDto);

    expect(exported.notifications.smtp.transport.password).toBe('');
    expect(exported.oauth.clientSecret).toBe('');
    expect(exported.map.lightStyle).toBe('https://tiles.example.com/light.json');
    expect(exported.machineLearning.imageDescription).not.toHaveProperty('pendingRequeueAt');
    expect(exported).not.toHaveProperty('revision');
    expect(exported.trash.days).toBe(30);
  });

  it('never journals secrets or URL credentials', () => {
    const baseline = configFixture();
    const draft = withChange((config) => {
      config.trash.days = 10;
      config.notifications.smtp.transport.password = 'new-secret';
      config.map.darkStyle = 'https://tiles.example.com/dark.json?api_key=xyz';
    });

    const { journal, skipped } = createJournal('r1', diffConfig(baseline, draft));

    expect(journal.changes).toEqual([{ path: 'trash.days', before: 30, after: 10 }]);
    expect(skipped).toBe(2);
    expect(JSON.stringify(journal)).not.toContain('new-secret');
    expect(JSON.stringify(journal)).not.toContain('xyz');
  });

  it('shows secrets in the review only as changed, and strips URL credentials', () => {
    expect(reviewValue('oauth.clientSecret', 'value')).toEqual({ kind: 'secret' });
    expect(reviewValue('map.lightStyle', 'https://t.example.com/s.json?token=abc')).toEqual({
      kind: 'text',
      text: 'https://t.example.com/s.json',
    });
    expect(reviewValue('trash.enabled', false)).toEqual({ kind: 'off' });
    expect(reviewValue('server.loginPageMessage', '')).toEqual({ kind: 'empty' });
    expect(reviewValue('theme.customCss', 'x'.repeat(400))).toMatchObject({ kind: 'text' });
    expect((reviewValue('theme.customCss', 'x'.repeat(400)) as { text: string }).text.length).toBeLessThanOrEqual(160);
  });

  it('labels a setting from its path', () => {
    expect(configPathLabel('ffmpeg.targetVideoCodec')).toBe('Target video codec');
    expect(configPathLabel('notifications.smtp.transport.ignoreCert')).toBe('Smtp › Transport › Ignore cert');
  });
});

describe('importConfig (FL-66 unsupported imported leaves)', () => {
  it('applies known leaves to the draft and reports the ones this server does not have', () => {
    const result = importConfig(configFixture(), {
      trash: { days: 12, retentionMode: 'strict' },
      futureFeature: { enabled: true },
    });

    expect(result.applied).toEqual(['trash.days']);
    expect(result.unsupported).toEqual(['trash.retentionMode', 'futureFeature.enabled']);
    expect(result.draft.trash.days).toBe(12);
    expect(result.draft).not.toHaveProperty('futureFeature');
  });

  it('refuses values of the wrong kind', () => {
    const result = importConfig(configFixture(), {
      trash: { days: '12', enabled: 'yes' },
      ffmpeg: { acceptedVideoCodecs: 'h264' },
    });

    expect(result.applied).toEqual([]);
    expect(result.unsupported).toEqual(['trash.days', 'trash.enabled', 'ffmpeg.acceptedVideoCodecs']);
  });

  it('never takes secrets from the file, and ignores server bookkeeping and revisions', () => {
    const result = importConfig(configFixture(), {
      revision: 'old',
      oauth: { clientSecret: '' },
      notifications: { smtp: { transport: { password: 'from-file' } } },
      machineLearning: { imageDescription: { pendingRequeueAt: '2026-01-01T00:00:00.000Z' } },
      physicalDeduplication: { masterUserId: '7c4f2a1e-0000-4000-8000-000000000001' },
    });

    expect(result.keptSecrets).toEqual(['oauth.clientSecret']);
    expect(result.draft.oauth.clientSecret).toBe('oauth-secret');
    // FL-67: a credential value in a file is never taken into the draft.
    expect(result.skippedSecrets).toEqual(['notifications.smtp.transport.password']);
    expect(result.draft.notifications.smtp.transport.password).toBe(
      configFixture().notifications.smtp.transport.password,
    );
    expect(result.applied).not.toContain('notifications.smtp.transport.password');
    expect(result.draft.machineLearning.imageDescription!.pendingRequeueAt).toBeNull();
    expect(result.draft.physicalDeduplication!.masterUserId).toBe('7c4f2a1e-0000-4000-8000-000000000001');
    expect(result.unsupported).toEqual([]);
  });

  it('refuses a file that is not one settings object', () => {
    expect(() => importConfig(configFixture(), [])).toThrow(TypeError);
    expect(() => importConfig(configFixture(), 'text')).toThrow(TypeError);
  });
});

describe('reload journal (FL-66 reload recovery)', () => {
  it('reads back a journal it wrote', () => {
    const { journal } = createJournal('r1', [{ path: 'trash.days', before: 30, after: 10 }]);
    expect(parseJournal(JSON.stringify(journal))).toEqual(journal);
  });

  it('drops malformed, oversized, unsafe or prototype-polluting entries', () => {
    expect(parseJournal(null)).toBeUndefined();
    expect(parseJournal('{')).toBeUndefined();
    expect(parseJournal(JSON.stringify({ version: 2, revision: 'r', changes: [] }))).toBeUndefined();
    expect(parseJournal('x'.repeat(1024 * 1024 + 1))).toBeUndefined();

    const parsed = parseJournal(
      JSON.stringify({
        version: 1,
        revision: 'r1',
        changes: [
          { path: '__proto__.polluted', before: null, after: true },
          { path: 'constructor.prototype.polluted', before: null, after: true },
          { path: 'oauth.clientSecret', before: '', after: 'secret' },
          { path: 'trash.days', before: 30, after: 10 },
          'not a change',
        ],
      }),
    );

    expect(parsed?.changes).toEqual([{ path: 'trash.days', before: 30, after: 10 }]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('recovers journaled changes and flags the ones changed elsewhere since', () => {
    const baseline = withChange((config) => (config.ffmpeg.crf = 30));
    const journal = {
      version: 1 as const,
      revision: 'r1',
      changes: [
        { path: 'trash.days', before: 30, after: 10 },
        { path: 'ffmpeg.crf', before: 23, after: 28 },
        { path: 'retired.setting', before: 1, after: 2 },
        { path: 'trash.enabled', before: true, after: 'yes' },
      ],
    };

    const { draft, recovered, conflicts, dropped } = recoverJournal(baseline, journal);

    expect(recovered).toBe(2);
    expect(dropped).toBe(2);
    expect(draft.trash.days).toBe(10);
    expect(draft.ffmpeg.crf).toBe(28);
    expect(conflicts).toEqual([{ path: 'ffmpeg.crf', before: 23, mine: 28, theirs: 30 }]);
  });

  it('treats a change as safe only without secrets or credentials', () => {
    expect(isJournalSafe({ path: 'trash.days', before: 1, after: 2 })).toBe(true);
    expect(isJournalSafe({ path: 'machineLearning.runpod.hfToken', before: '', after: 'hf_x' })).toBe(false);
    expect(isJournalSafe({ path: 'machineLearning.urls', before: [], after: ['https://u:p@ml.example.com'] })).toBe(
      false,
    );
  });
});
