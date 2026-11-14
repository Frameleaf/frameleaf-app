import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { SystemMetadataKey } from 'src/enum.js';
import { ClientsPaymentsService, type ClientsPaymentsState } from 'src/services/clients-payments.service.js';

// The identity key itself is not what these tests are about.
vi.mock('src/utils/frameleaf-cloud-gateway.js', async (original) => ({
  ...(await original<typeof import('src/utils/frameleaf-cloud-gateway.js')>()),
  loadInstanceIdentity: vi.fn(() => Promise.resolve({})),
}));

const instanceId = '00000000-0000-4000-8000-000000000001';
const cloudUrl = 'https://cloud.example';
const ownerId = '00000000-0000-4000-8000-0000000000aa';
const fingerprint = createHash('sha256').update(`${instanceId}${ownerId}`).digest('hex');
const auth = { user: { id: ownerId }, session: { id: 's' } } as unknown as AuthDto;

const setup = (answers: Record<string, unknown>) => {
  let state: ClientsPaymentsState | null = null;
  const requests: { url: string; method?: string; body?: unknown; headers?: Record<string, string> }[] = [];
  const metadata = {
    get: vi.fn((key: SystemMetadataKey) => {
      if (key === SystemMetadataKey.FrameleafCloudLink)
        return Promise.resolve({ status: 'linked', instanceId, cloudUrl });
      if (key === SystemMetadataKey.ClientsPayments) return Promise.resolve(state);
      return Promise.resolve(null);
    }),
    setEntry: vi.fn((_key: SystemMetadataKey, _field: string, entry: string, value: unknown) => {
      state = { accounts: { ...state?.accounts, [entry]: value as ClientsPaymentsState['accounts'][string] } };
      return Promise.resolve();
    }),
  };
  const cloud = {
    discovery: vi.fn(() => Promise.resolve({ api: 'https://api.cloud.example' })),
    accessToken: vi.fn(() => Promise.resolve({ accessToken: 't' })),
    requestJson: vi.fn((schema: { parse: (v: unknown) => unknown }, request: (typeof requests)[number]) => {
      requests.push(request);
      const key = `${request.method ?? 'GET'} ${new URL(request.url).pathname}`;
      if (!(key in answers)) return Promise.reject(new Error(`unexpected ${key}`));
      return Promise.resolve(schema.parse(answers[key]));
    }),
  };
  const service = new ClientsPaymentsService(
    cloud as never,
    { getEnv: () => ({ frameleafCloud: { url: cloudUrl } }) } as never,
    { withLock: (_lock: unknown, fn: () => unknown) => fn() } as never,
    metadata as never,
    { loadOrCreate: vi.fn(), currentSigner: vi.fn() } as never,
    { setContext: vi.fn(), warn: vi.fn() } as never,
  );
  return { service, requests, state: () => state, cloud };
};

const account = {
  status: 'active',
  chargesEnabled: true,
  payoutsEnabled: true,
  requirementsDue: [],
  country: 'CA',
  defaultCurrency: 'cad',
};
const event = (id: string, extra: object) => ({
  id,
  type: 'payment.succeeded',
  owner: fingerprint,
  createdAt: new Date().toISOString(),
  reference: 'order:1',
  sessionId: 'cs_1',
  paymentIntent: 'pi_1',
  amount: 1500,
  currency: 'cad',
  payerEmail: null,
  account: null,
  ...extra,
});

describe(ClientsPaymentsService.name, () => {
  it('remembers the account, hands payment events to their feature and acknowledges only what was handled', async () => {
    const s = setup({
      'GET /v1/instance/clients/payments/account': account,
      'GET /v1/instance/clients/payments/events': {
        events: [
          event('evt_ok', {}),
          event('evt_fail', { reference: 'order:2' }),
          event('evt_unknown_kind', { reference: 'invoice:3' }),
          event('evt_stranger', { owner: 'f'.repeat(64) }),
          event('evt_stale_stranger', {
            owner: 'f'.repeat(64),
            createdAt: new Date(Date.now() - 8 * 86_400_000).toISOString(),
          }),
          event('evt_account', {
            type: 'account.updated',
            reference: null,
            account: { ...account, chargesEnabled: false, status: 'pending' },
          }),
        ],
      },
      'POST /v1/instance/clients/payments/events/ack': {},
    });
    expect(await s.service.account(auth)).toMatchObject({ status: 'active', chargesEnabled: true, legacy: false });
    expect(s.requests[0].headers).toEqual({ 'X-Frameleaf-User-Fingerprint': fingerprint });
    expect(await s.service.ready(ownerId)).toBe(true);

    const handler = vi.fn((e: { reference: string | null }) =>
      e.reference === 'order:2' ? Promise.reject(new Error('busy')) : Promise.resolve(),
    );
    s.service.onPayment('order', handler);
    await s.service.collect();
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: 'evt_ok', ownerId }));
    const ack = s.requests.find((r) => r.url.endsWith('/events/ack'))!;
    // A failed handler, a kind nobody handles and an unknown studio stay for the next collection.
    // …except one a week old that nothing here can store, so it can't hold back newer payments.
    expect(ack.body).toEqual({ ids: ['evt_ok', 'evt_stale_stranger', 'evt_account'] });
    expect(s.state()!.accounts[ownerId]).toMatchObject({ status: 'pending', chargesEnabled: false });
    expect(await s.service.ready(ownerId)).toBe(false);
  });

  it('does not contact Frameleaf Cloud while no studio has an account', async () => {
    const s = setup({});
    await s.service.collect();
    expect(s.cloud.requestJson).not.toHaveBeenCalled();
  });

  it('refuses a gallery guest or an API key', async () => {
    const s = setup({});
    await expect(s.service.account({ ...auth, sharedLink: {} } as never)).rejects.toThrow('Studio session required');
    await expect(s.service.account({ ...auth, apiKey: {} } as never)).rejects.toThrow('Studio session required');
  });
});
