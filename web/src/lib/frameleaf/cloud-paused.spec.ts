import { pausedRefusalMessage } from '$lib/frameleaf/cloud-paused';

vi.mock('@frameleaf/sdk', async (original) => ({
  ...(await original<typeof import('@frameleaf/sdk')>()),
  isHttpError: (error: unknown) => (error as { name?: string })?.name === 'HttpError',
}));

const httpError = (status: number, data: Record<string, unknown>) => ({ name: 'HttpError', status, data });

describe(pausedRefusalMessage.name, () => {
  it('reads Frameleaf Cloud’s own message from a paused refusal (FC-62)', () => {
    for (const code of ['service-paused', 'capacity', 'relay-unavailable']) {
      expect(pausedRefusalMessage(httpError(503, { code, message: '  Paused for maintenance.  ' }))).toBe(
        'Paused for maintenance.',
      );
    }
  });

  it('is null for anything else', () => {
    expect(pausedRefusalMessage(httpError(503, { code: 'service-paused', message: ' ' }))).toBeNull();
    expect(pausedRefusalMessage(httpError(503, { code: 'down', message: 'Down' }))).toBeNull();
    expect(pausedRefusalMessage(httpError(409, { code: 'service-paused', message: 'Paused' }))).toBeNull();
    expect(pausedRefusalMessage(new Error('offline'))).toBeNull();
  });
});
