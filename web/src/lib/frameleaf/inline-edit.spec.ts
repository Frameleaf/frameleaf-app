import {
  classifyInlineEditError,
  inlineEditMessageKey,
  inlineEditRecovery,
  runInlineEdit,
} from '$lib/frameleaf/inline-edit';

const httpError = (status: number) => ({ status, data: { statusCode: status, message: 'nope' } });

describe('classifyInlineEditError', () => {
  it('treats a rejected value as invalid, which no retry can fix', () => {
    for (const status of [400, 422]) {
      expect(classifyInlineEditError(httpError(status))).toBe('invalid');
    }
  });

  it('treats an authorization failure as forbidden', () => {
    for (const status of [401, 403]) {
      expect(classifyInlineEditError(httpError(status))).toBe('forbidden');
    }
  });

  it('treats a missing or conflicting asset as stale', () => {
    for (const status of [404, 409, 410]) {
      expect(classifyInlineEditError(httpError(status))).toBe('stale');
    }
  });

  it('treats a request without a verdict as a network failure', () => {
    for (const status of [0, 408, 429, 500, 502, 503]) {
      expect(classifyInlineEditError(httpError(status))).toBe('network');
    }
  });

  it('classifies a fetch transport failure as network, not unknown', () => {
    expect(classifyInlineEditError(new TypeError('Failed to fetch'))).toBe('network');
  });

  it('falls back to unknown for anything that is not an HTTP failure', () => {
    expect(classifyInlineEditError(new Error('boom'))).toBe('unknown');
    expect(classifyInlineEditError('boom')).toBe('unknown');
  });

  it('does not invent a classification for an unmapped status', () => {
    expect(classifyInlineEditError(httpError(418))).toBe('unknown');
  });
});

describe('inlineEditRecovery', () => {
  it('never offers a retry that cannot succeed', () => {
    expect(inlineEditRecovery('invalid')).toBe('none');
    expect(inlineEditRecovery('forbidden')).toBe('none');
  });

  it('reloads a stale asset rather than replaying the write over it', () => {
    expect(inlineEditRecovery('stale')).toBe('reload');
  });

  it('offers a retry when the write may never have been applied', () => {
    expect(inlineEditRecovery('network')).toBe('retry');
    expect(inlineEditRecovery('unknown')).toBe('retry');
  });
});

describe('inlineEditMessageKey', () => {
  it('names a key per failure so every message is translated', () => {
    expect(inlineEditMessageKey('stale')).toBe('frameleaf_info_error_stale');
  });
});

describe('runInlineEdit', () => {
  it('returns the value of a successful edit', async () => {
    await expect(runInlineEdit(async () => 'saved')).resolves.toEqual({ ok: true, value: 'saved' });
  });

  it('classifies a failure and states the recovery alongside it', async () => {
    const error = httpError(403);
    const outcome = await runInlineEdit(() => Promise.reject(error));

    expect(outcome).toEqual({ ok: false, failure: 'forbidden', recovery: 'none', error });
  });

  it('does not swallow the original error, so the caller can still report the server message', async () => {
    const error = httpError(500);
    const outcome = await runInlineEdit(() => Promise.reject(error));

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toBe(error);
  });
});
