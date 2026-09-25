import { cloneDeep } from 'lodash-es';
import { describe, expect, it } from 'vitest';
import { defaults } from 'src/dtos/config.dto.js';
import {
  CONFIG_HISTORY_LIMITS,
  appendConfigHistory,
  credentialHistoryTitle,
  describeConfigChanges,
  describeObjectChanges,
  readConfigHistory,
  reviewHistoryTitle,
  stripUrlCredentials,
} from 'src/utils/config-history.js';

const entry = (id: string) => ({ id, createdAt: '2026-09-23T10:00:00.000Z', actorId: 'admin', actorName: 'Admin' });

describe('settings change history (FL-66)', () => {
  it('lists each changed setting with its value before and after', () => {
    const next = cloneDeep(defaults);
    next.trash.days = defaults.trash.days + 5;
    next.ffmpeg.acceptedVideoCodecs = [];

    expect(describeConfigChanges(defaults, next)).toEqual([
      { path: 'ffmpeg.acceptedVideoCodecs', before: JSON.stringify(defaults.ffmpeg.acceptedVideoCodecs), after: '[]' },
      { path: 'trash.days', before: String(defaults.trash.days), after: String(defaults.trash.days + 5) },
    ]);
  });

  it('records a credential only as replaced or cleared, never with a value', () => {
    const before = cloneDeep(defaults);
    before.oauth.clientSecret = 'oauth-old';
    before.notifications.smtp.transport.password = 'smtp-old';
    const after = cloneDeep(before);
    after.oauth.clientSecret = 'oauth-new';
    after.notifications.smtp.transport.password = '';

    const changes = describeConfigChanges(before, after);

    expect(changes).toEqual([
      { path: 'notifications.smtp.transport.password', before: null, after: null, credential: 'cleared' },
      { path: 'oauth.clientSecret', before: null, after: null, credential: 'replaced' },
    ]);
    const text = JSON.stringify(changes);
    for (const secret of ['oauth-old', 'oauth-new', 'smtp-old', 'Configured']) {
      expect(text).not.toContain(secret);
    }
  });

  it('never records credentials inside URLs', () => {
    const next = cloneDeep(defaults);
    next.oauth.issuerUrl = 'https://user:hunter2@id.example/realms/home?client_secret=abc&prompt=login';

    const [change] = describeConfigChanges(defaults, next);

    expect(change.path).toBe('oauth.issuerUrl');
    expect(change.after).toBe(JSON.stringify('https://id.example/realms/home?prompt=login'));
    expect(stripUrlCredentials('https://id.example')).toBe('https://id.example');
    expect(stripUrlCredentials('not a url')).toBe('not a url');
  });

  it('leaves out the re-queue bookkeeping the server writes on its own', () => {
    const next = cloneDeep(defaults);
    next.machineLearning.imageDescription.pendingRequeueAt = '2026-09-23T10:00:00.000Z';

    expect(describeConfigChanges(defaults, next)).toEqual([]);
  });

  it('shortens long values', () => {
    const next = cloneDeep(defaults);
    next.theme.customCss = 'a'.repeat(1000);

    const [change] = describeConfigChanges(defaults, next);

    expect(change.after!.length).toBe(CONFIG_HISTORY_LIMITS.valueCharacters);
    expect(change.after!.endsWith('…')).toBe(true);
  });

  it('keeps the newest entries first within the limit, and counts changes left out', () => {
    let history = readConfigHistory(null);
    for (let index = 0; index < CONFIG_HISTORY_LIMITS.entries + 5; index++) {
      history = appendConfigHistory(history, entry(`entry-${index}`), [
        { path: 'trash.days', before: '1', after: '2' },
      ]);
    }

    expect(history.entries).toHaveLength(CONFIG_HISTORY_LIMITS.entries);
    expect(history.entries[0].id).toBe(`entry-${CONFIG_HISTORY_LIMITS.entries + 4}`);

    const many = Array.from({ length: CONFIG_HISTORY_LIMITS.changes + 3 }, (_, index) => ({
      path: `setting.${index}`,
      before: '1',
      after: '2',
    }));
    const [latest] = appendConfigHistory(readConfigHistory(undefined), entry('many'), many).entries;
    expect(latest.changes).toHaveLength(CONFIG_HISTORY_LIMITS.changes);
    expect(latest.omittedChanges).toBe(3);
  });

  it('reads anything unexpected as an empty history', () => {
    expect(readConfigHistory({ entries: 'nope' })).toEqual({ entries: [] });
    expect(readConfigHistory({ trash: { days: 3 } })).toEqual({ entries: [] });
    expect(
      readConfigHistory({ entries: [{ id: 'x' }, 'text', { ...entry('ok'), changes: [], omittedChanges: 0 }] }),
    ).toEqual({
      entries: [{ ...entry('ok'), changes: [], omittedChanges: 0 }],
    });
  });
});

describe('FL-71 CC-10 history titles and object changes', () => {
  it('names credential and review entries without values', () => {
    expect(credentialHistoryTitle('oauth-client-secret', 'replaced')).toBe('Updated OAuth client secret');
    expect(credentialHistoryTitle('smtp-password', 'cleared')).toBe('Cleared email server password');
    expect(reviewHistoryTitle('Recovery readiness')).toBe('Reviewed: Recovery readiness');
  });

  it('lists leaf changes, leaves secret-looking keys out and strips URL credentials', () => {
    expect(
      describeObjectChanges(
        { memories: { enabled: true }, apiToken: 'a', url: 'https://x.test/' },
        { memories: { enabled: false }, apiToken: 'b', url: 'https://user:pw@x.test/' },
      ),
    ).toEqual([{ path: 'memories.enabled', before: 'true', after: 'false' }]);
  });
});
