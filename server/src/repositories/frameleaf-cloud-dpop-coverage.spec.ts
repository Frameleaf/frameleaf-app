import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import z from 'zod';
import { FrameleafCloudPublicCall, FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { HEARTBEAT_REPORTS_CAPABILITIES, INSTANCE_CAPABILITIES } from 'src/services/frameleaf-cloud.service.js';
import { buildHeartbeat, defaultPermissions } from 'src/utils/frameleaf-cloud-link.js';
import { FrameleafKeySigner } from 'src/utils/frameleaf-dpop.js';

/**
 * FC-50 (CLD-201): this server declares the `dpop` capability, so Frameleaf Cloud refuses it every
 * unbound token, at the token endpoint, on api. and on ml.<region>. That is only safe while every
 * cloud call carries a DPoP proof by the instance key. These checks fail when a new cloud call could
 * go out without one: every call goes through `FrameleafCloudRepository`, which refuses to send a
 * request that is neither DPoP-signed nor one of the named public calls, and no other file may open
 * its own connection without being reviewed and listed here.
 */
const SRC = join(import.meta.dirname, '..');

const sourceFiles = (dir = SRC): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [relative(SRC, path)] : [];
  });

const filesMatching = (pattern: RegExp) =>
  sourceFiles()
    .filter((file) => pattern.test(readFileSync(join(SRC, file), 'utf8')))
    .toSorted();

/**
 * Every file that calls `fetch` itself, and why that is not an unproofed Frameleaf Cloud call. A new
 * file here must send its cloud calls through `FrameleafCloudRepository` instead.
 */
const RAW_FETCH = {
  // Bounded request/body transport used only by the local and self-hosted ML prediction path below.
  'queue/http.ts': 'ML worker deadline transport',
  // the one Frameleaf Cloud client: every api., id. and ml. call, DPoP-signed or a named public call
  'repositories/frameleaf-cloud.repository.ts': 'the Frameleaf Cloud client',
  // presigned job-storage addresses (no instance token), each checked by cloudAddressProblem
  'repositories/frameleaf-cloud-ml.repository.ts': 'presigned ML job storage',
  // SigV4 requests to the backup bucket with the grant's scoped credentials (the grant itself is DPoP)
  'repositories/cloud-backup-store.repository.ts': 'backup object storage',
  // local and self-hosted ML workers
  'repositories/machine-learning.repository.ts': 'ML workers',
  // generic OIDC profile pictures
  'repositories/oauth.repository.ts': 'OIDC profile picture',
  // the public release feed: anonymous on purpose, no instance identity is ever sent (FL-80, FL-192)
  'repositories/server-info.repository.ts': 'public release feed',
  // FL-283: fixed api.stripe.com checkout/reconciliation with the studio's Stripe key; never a Cloud/media call.
  'services/photography-workflow.service.ts': 'studio-owned Stripe checkout and payment reconciliation',
  // a user's own workflow HTTP step
  'services/workflow-execution.service.ts': 'workflow HTTP step',
  // Buddy vault requests carry source-key DPoP and require a pinned destination receipt (buddy-backup-client.spec.ts).
  // Cloud grants still use FrameleafCloudRepository through BuddyBackupPeerService.cloud.
  'utils/buddy-backup-client.ts': 'DPoP-authenticated Buddy peer transport',
};

/** Every file that opens a socket itself. */
const RAW_SOCKETS = {
  // the relay tunnel: its token comes from a DPoP call and the tunnel's PROOF is signed by the instance key
  'edge/edge-relay.service.ts': 'relay tunnel',
  // the edge worker's own upstream (this server) on the local host
  'edge/edge-proxy.service.ts': 'local upstream',
  // a probe of this server's own direct listener
  'services/frameleaf-remote-access.service.ts': 'local direct-listener probe',
};

/** Where each named public call is made; anything else must carry `dpop`. */
const PUBLIC_CALLS: Array<[string, FrameleafCloudPublicCall]> = [
  ['repositories/frameleaf-cloud-ml.repository.ts', FrameleafCloudPublicCall.MlPing],
  ['repositories/frameleaf-cloud.repository.ts', FrameleafCloudPublicCall.Discovery],
  ['services/frameleaf-cloud.service.ts', FrameleafCloudPublicCall.DeviceAuthorization],
  ['services/frameleaf-cloud.service.ts', FrameleafCloudPublicCall.DeviceToken],
  ['services/frameleaf-license.service.ts', FrameleafCloudPublicCall.UnlinkedLicense],
  ['services/frameleaf-license.service.ts', FrameleafCloudPublicCall.UnlinkedLicense],
];

const signer: FrameleafKeySigner = {
  kid: 'kid-1',
  publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'x' },
  sign: () => 'proof',
};

describe('every Frameleaf Cloud call sends a DPoP proof (FC-50, CLD-201)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('source', () => {
    it('has no raw fetch outside the reviewed list', () => {
      expect(filesMatching(/\bfetch\(/)).toEqual(Object.keys(RAW_FETCH).toSorted());
    });

    it('restricts the deadline transport to the reviewed ML worker caller', () => {
      expect(filesMatching(/\bfetchJobText\(/)).toEqual([
        'queue/http.ts',
        'repositories/machine-learning.repository.ts',
      ]);
    });

    it('bounds the photography exception to studio-owned Stripe requests without media or client secrets (FL-283)', () => {
      const source = readFileSync(join(SRC, 'services/photography-workflow.service.ts'), 'utf8');
      expect(source.match(/\bfetch\(/g)).toHaveLength(1);
      expect(source).toContain('fetch(`https://api.stripe.com/v1/${endpoint}`, {');
      expect(source).toContain('const secret = process.env.PHOTOGRAPHY_STRIPE_SECRET_KEY;');
      expect(source).toContain('headers: { Authorization: `Bearer ${this.stripeConfig()}`, ...options.headers },');
      expect(
        source
          .matchAll(/\bthis\.stripe\(([\s\S]*?)\);/g)
          .map(([, args]) => args.replaceAll(/\s+/g, ' ').trim())
          .toArray(),
      ).toEqual([
        "'checkout/sessions', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': `photography-${order.id}` }, body: form, }",
        '`payment_intents/${encodeURIComponent(object.payment_intent)}`',
        '`checkout/sessions/${encodeURIComponent(order.checkoutId)}?expand[]=payment_intent.latest_charge`,',
      ]);
      // The only outbound payload is an immutable order quote and studio return URLs.
      const form = source.match(/const form = new URLSearchParams\(\{([\s\S]*?)\}\);/)?.[1];
      expect(
        form
          ?.trim()
          .split('\n')
          .map((line) => line.trim()),
      ).toEqual([
        "mode: 'payment',",
        'success_url: success,',
        'cancel_url: cancel,',
        'client_reference_id: order.id,',
        "'metadata[orderId]': order.id,",
        "'payment_intent_data[metadata][orderId]': order.id,",
        "'line_items[0][quantity]': '1',",
        "'line_items[0][price_data][currency]': order.currency.toLowerCase(),",
        "'line_items[0][price_data][unit_amount]': String(order.total),",
        "'line_items[0][price_data][product_data][name]': 'Digital photograph order',",
      ]);
    });

    it('opens no socket outside the reviewed list', () => {
      expect(
        filesMatching(/\b(?:tls|net|https?)\.(?:connect|request|get)\(|\bcreateConnection\(|new WebSocket\(/),
      ).toEqual(Object.keys(RAW_SOCKETS).toSorted());
    });

    it('names the public calls only where they are made', () => {
      const found: Array<[string, FrameleafCloudPublicCall]> = [];
      for (const file of sourceFiles()) {
        for (const [, name] of readFileSync(join(SRC, file), 'utf8').matchAll(
          /unauthenticated: FrameleafCloudPublicCall\.(\w+)/g,
        )) {
          found.push([file, FrameleafCloudPublicCall[name as keyof typeof FrameleafCloudPublicCall]]);
        }
      }
      found.sort(([a, x], [b, y]) => `${a} ${x}`.localeCompare(`${b} ${y}`));
      expect(found).toEqual(PUBLIC_CALLS.toSorted(([a, x], [b, y]) => `${a} ${x}`.localeCompare(`${b} ${y}`)));
    });

    it('sends a plain bearer credential only with the registration, beside its DPoP proof', () => {
      const bearers = sourceFiles().flatMap((file) => {
        const lines = readFileSync(join(SRC, file), 'utf8').split('\n');
        return lines.flatMap((line, index) =>
          /\bbearer: /.test(line) ? [{ file, call: lines.slice(Math.max(0, index - 6), index + 1).join('\n') }] : [],
        );
      });
      expect(bearers.map(({ file }) => file)).toEqual(['services/frameleaf-cloud.service.ts']);
      expect(bearers[0].call).toMatch(/dpop: \{ signer \}/);
    });
  });

  describe('FrameleafCloudRepository', () => {
    const repository = () => new FrameleafCloudRepository(LoggingRepository.create());
    const url = 'https://api.cloud.test/v1/instance/thing';

    it('refuses to send a call without a proof, and sends nothing', async () => {
      const fetch = vi.spyOn(globalThis, 'fetch');
      await expect(repository().requestJson(z.unknown(), { method: 'POST', url, body: {} })).rejects.toThrow(
        'carries no DPoP proof',
      );
      await expect(
        repository().requestJson(z.unknown(), {
          url,
          bearer: 'token',
          unauthenticated: FrameleafCloudPublicCall.Discovery,
        }),
      ).rejects.toThrow('carries no DPoP proof');
      await expect(
        repository().requestJson(z.unknown(), {
          url,
          dpop: { signer, accessToken: 'token' },
          unauthenticated: FrameleafCloudPublicCall.Discovery,
        }),
      ).rejects.toThrow('either DPoP-signed or a named public call');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('signs a fresh proof for every call, with ath, htm and htu, and never a Bearer token', async () => {
      const proofs: Array<Record<string, unknown>> = [];
      const recording: FrameleafKeySigner = {
        ...signer,
        sign: (header, payload) => {
          proofs.push({ header, ...payload });
          return 'proof';
        },
      };
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(() => Promise.resolve(new Response('{}', { status: 200 })));
      const cloud = repository();
      await cloud.requestJson(z.unknown(), { method: 'POST', url, dpop: { signer: recording, accessToken: 'token' } });
      await cloud.requestJson(z.unknown(), {
        method: 'POST',
        url: `${url}?q=1`,
        dpop: { signer: recording, accessToken: 'token' },
      });

      expect(proofs).toHaveLength(2);
      expect(proofs[0]).toMatchObject({ htm: 'POST', htu: url, ath: expect.any(String), iat: expect.any(Number) });
      expect(proofs[1]).toMatchObject({ htu: url });
      expect(proofs[0].jti).not.toBe(proofs[1].jti);
      for (const [, init] of fetch.mock.calls) {
        const headers = (init as RequestInit).headers as Record<string, string>;
        expect(headers.Authorization).toBe('DPoP token');
        expect(headers.DPoP).toBe('proof');
      }
    });
  });

  describe('the dpop capability', () => {
    it('is declared at registration, with every call covered', () => {
      expect(INSTANCE_CAPABILITIES).toContain('dpop');
    });

    it('is reported in every check-in, so servers linked earlier opt in without relinking', () => {
      expect(HEARTBEAT_REPORTS_CAPABILITIES).toBe(true);
      const input = {
        version: '2.0.0',
        bootId: 'boot',
        uptimeSec: 1,
        health: { database: 'ok', storage: 'ok', jobs: 'ok' } as const,
        endpoints: [],
        remoteAccess: { enabled: false, relayConnected: false, direct: false },
        permissions: defaultPermissions(),
        licenseKid: null,
      };
      expect(buildHeartbeat(input)).not.toHaveProperty('capabilities');
      expect(buildHeartbeat({ ...input, capabilities: INSTANCE_CAPABILITIES })).toMatchObject({
        capabilities: [...INSTANCE_CAPABILITIES],
      });
    });
  });
});
