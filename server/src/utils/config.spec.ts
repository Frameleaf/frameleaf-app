import { cloneDeep } from 'lodash-es';
import { describe, expect, it } from 'vitest';
import { defaults } from 'src/dtos/config.dto.js';
import { getConfigRevision } from 'src/utils/config.js';

describe('getConfigRevision (FL-66 settings revision)', () => {
  it('is the same for equal settings whatever their key order', () => {
    const reordered = Object.fromEntries(Object.entries(cloneDeep(defaults)).toReversed()) as typeof defaults;
    expect(getConfigRevision(reordered)).toBe(getConfigRevision(defaults));
  });

  it('changes when any saved setting changes', () => {
    const trash = cloneDeep(defaults);
    trash.trash.days = defaults.trash.days + 1;
    const smtp = cloneDeep(defaults);
    smtp.notifications.smtp.transport.password = 'another-password';
    const oauth = cloneDeep(defaults);
    oauth.oauth.clientSecret = 'rotated-secret';

    const revisions = new Set([defaults, trash, smtp, oauth].map((config) => getConfigRevision(config)));
    expect(revisions.size).toBe(4);
  });

  it('never digests write-only secrets, only whether they are set', () => {
    const first = cloneDeep(defaults);
    first.oauth.clientSecret = 'secret_first';
    first.notifications.smtp.transport.password = 'smtp_first';
    const second = cloneDeep(defaults);
    second.oauth.clientSecret = 'secret_second';
    second.notifications.smtp.transport.password = 'smtp_second';

    expect(getConfigRevision(first)).toBe(getConfigRevision(second));
    expect(getConfigRevision(first)).not.toBe(getConfigRevision(defaults));
  });

  it('ignores the re-queue bookkeeping the server writes on its own', () => {
    const deferred = cloneDeep(defaults);
    deferred.machineLearning.imageDescription.pendingRequeueAt = '2026-09-23T10:00:00.000Z';
    deferred.machineLearning.imageDescription.lastConfigChangeAt = '2026-09-22T10:00:00.000Z';

    expect(getConfigRevision(deferred)).toBe(getConfigRevision(defaults));
  });

  it('never changes the config it digests', () => {
    const config = cloneDeep(defaults);
    config.machineLearning.imageDescription.pendingRequeueAt = '2026-09-23T10:00:00.000Z';

    getConfigRevision(config);

    expect(config.machineLearning.imageDescription.pendingRequeueAt).toBe('2026-09-23T10:00:00.000Z');
  });

  it('is short, opaque text', () => {
    expect(getConfigRevision(defaults)).toMatch(/^[0-9a-f]{32}$/);
  });
});
