import { describe, expect, it } from 'vitest';
import { MediaOperationDestination, MediaOperationKind, RenderWorkerStatus } from 'src/enum.js';
import {
  BUNDLED_RENDER_WORKER_APPROVAL,
  evaluateBundledAdmissionBudget,
  evaluateBundledRenderSession,
  isBundledRenderWorker,
  isInternalWorkerOrigin,
  renderWorkerOriginOf,
} from 'src/utils/bundled-render-worker.js';
import { GpuWorkingBudgetApprovalSchema, evaluateApprovedRenderSession } from 'src/utils/gpu-working-budget-policy.js';
import { LocalDestinationHealthProvider } from 'src/utils/render-admission.js';

const GIB = 1024 ** 3;
const now = new Date('2026-10-14T12:00:00.000Z');

const worker = (overrides: Record<string, unknown> = {}) => ({
  id: '0195e2a0-0000-7000-8000-00000000b001',
  status: RenderWorkerStatus.Active,
  kinds: [MediaOperationKind.StudioExport],
  engineDigest: null,
  conformanceMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxConcurrentOperations: 1,
  gpuMemoryBytes: null,
  gpuWorkingBudgetApproval: BUNDLED_RENDER_WORKER_APPROVAL,
  ...overrides,
});

const session = (overrides: Record<string, unknown> = {}) => ({
  workerId: '0195e2a0-0000-7000-8000-00000000b001',
  revokedAt: null,
  expiresAt: new Date(now.getTime() + 60 * 60_000),
  engineDigest: '4d62e8082c5eb387a96275bcbd323d28f6e41a62',
  conformanceReportedAt: new Date(now.getTime() - 60_000),
  scopes: [MediaOperationKind.StudioExport],
  gpuMemoryBytes: String(4 * GIB),
  gpuWorkingBudgetEvidence: null,
  codecs: ['webcodecs-avc', 'webcodecs-aac'],
  colorPrecision: null,
  lastUsedAt: new Date(now.getTime() - 5000),
  ...overrides,
});

const capabilities = { codecs: ['webcodecs-avc', 'webcodecs-aac'], formats: ['mp4'] };

describe('bundled render worker (FL-408)', () => {
  describe('trust marker', () => {
    it('is recognised only in its exact server-written shape', () => {
      expect(isBundledRenderWorker({ gpuWorkingBudgetApproval: BUNDLED_RENDER_WORKER_APPROVAL })).toBe(true);
      expect(isBundledRenderWorker({ gpuWorkingBudgetApproval: null })).toBe(false);
      expect(isBundledRenderWorker({ gpuWorkingBudgetApproval: { bundled: 'something-else' } })).toBe(false);
      expect(
        isBundledRenderWorker({ gpuWorkingBudgetApproval: { ...BUNDLED_RENDER_WORKER_APPROVAL, evidence: {} } }),
      ).toBe(false);
    });

    it('cannot be set through the administrator approval schema', () => {
      expect(GpuWorkingBudgetApprovalSchema.safeParse(BUNDLED_RENDER_WORKER_APPROVAL).success).toBe(false);
    });
  });

  describe('isInternalWorkerOrigin', () => {
    it.each(['127.0.0.1', '10.1.2.3', '172.18.0.5', '192.168.1.20', '::1', '::ffff:172.18.0.5', 'fd00::5', 'fe80::1'])(
      'accepts the container or home network address %s',
      (remoteAddress) => {
        expect(isInternalWorkerOrigin({ remoteAddress, forwarded: false })).toBe(true);
      },
    );

    it.each(['203.0.113.9', '8.8.8.8', '2001:db8::1', '::ffff:8.8.8.8', 'not-an-ip', '', null, undefined])(
      'refuses %s',
      (remoteAddress) => {
        expect(isInternalWorkerOrigin({ remoteAddress, forwarded: false })).toBe(false);
      },
    );

    it('refuses anything a proxy forwarded, even from a private peer', () => {
      expect(isInternalWorkerOrigin({ remoteAddress: '172.18.0.2', forwarded: true })).toBe(false);
    });

    it('reads the socket peer and any forwarding header from a request', () => {
      expect(renderWorkerOriginOf({ socket: { remoteAddress: '172.18.0.5' }, headers: {} })).toEqual({
        remoteAddress: '172.18.0.5',
        forwarded: false,
      });
      for (const header of ['x-forwarded-for', 'forwarded', 'x-real-ip']) {
        expect(
          renderWorkerOriginOf({ socket: { remoteAddress: '172.18.0.5' }, headers: { [header]: '203.0.113.9' } })
            .forwarded,
        ).toBe(true);
      }
    });
  });

  describe('evaluateBundledAdmissionBudget', () => {
    const window = {
      conformanceExpiresAt: new Date(now.getTime() + 2000),
      credentialExpiresAt: new Date(now.getTime() + 1000),
    };

    it('qualifies the reported working memory and expires with the earlier of conformance and credential', () => {
      expect(evaluateBundledAdmissionBudget({ reportedBytes: String(4 * GIB), ...window })).toEqual({
        valid: true,
        measuredBytes: String(4 * GIB),
        qualifiedBytes: String(4 * GIB),
        expiresAt: window.credentialExpiresAt.toISOString(),
      });
    });

    it.each([null, undefined, '', '-1', '1.5', String(GIB)])('refuses missing or too little memory (%s)', (value) => {
      expect(evaluateBundledAdmissionBudget({ reportedBytes: value, ...window })).toEqual({
        valid: false,
        reason: 'evidence-invalid',
      });
    });
  });

  describe('evaluateBundledRenderSession', () => {
    it('qualifies a live session with its reported outputs', () => {
      expect(evaluateBundledRenderSession({ worker: worker(), session: session(), capabilities, now })).toMatchObject({
        valid: true,
        qualifiedBytes: String(4 * GIB),
      });
    });

    it.each([
      { name: 'revoked worker', worker: { status: RenderWorkerStatus.Revoked }, session: {} },
      { name: 'revoked session', worker: {}, session: { revokedAt: new Date(now.getTime() - 1) } },
      { name: 'expired session', worker: {}, session: { expiresAt: new Date(now.getTime() - 1) } },
      {
        name: 'stale conformance',
        worker: { conformanceMaxAgeMs: 1000 },
        session: { conformanceReportedAt: new Date(now.getTime() - 60_000) },
      },
      { name: 'pinned to another engine', worker: { engineDigest: 'other' }, session: {} },
      { name: 'another worker', worker: {}, session: { workerId: 'someone-else' } },
      { name: 'more than one claim at a time', worker: { maxConcurrentOperations: 2 }, session: {} },
      { name: 'codecs that differ from the capability row', worker: {}, session: { codecs: ['libx264'] } },
      {
        name: 'worker that stopped asking for work',
        worker: {},
        session: { lastUsedAt: new Date(now.getTime() - 3 * 60_000) },
      },
      { name: 'session never used', worker: {}, session: { lastUsedAt: null } },
    ])('refuses a $name', ({ worker: workerOverrides, session: sessionOverrides }) => {
      expect(
        evaluateBundledRenderSession({
          worker: worker(workerOverrides),
          session: session(sessionOverrides),
          capabilities,
          now,
        }),
      ).toEqual({ valid: false, reason: 'session-unqualified' });
    });

    it('refuses a session that proved no outputs', () => {
      expect(evaluateBundledRenderSession({ worker: worker(), session: session(), capabilities: null, now })).toEqual({
        valid: false,
        reason: 'session-unqualified',
      });
    });

    it('is what the approved-session policy answers for a bundled worker, without hardware evidence', () => {
      expect(
        evaluateApprovedRenderSession({ worker: worker(), session: session(), capabilities, now } as never),
      ).toMatchObject({ valid: true, qualifiedBytes: String(4 * GIB) });
      // the same session on an ordinary worker still needs an approved measured profile
      expect(
        evaluateApprovedRenderSession({
          worker: worker({ gpuWorkingBudgetApproval: null }),
          session: session({ engineDigest: null }),
          capabilities,
          now,
        } as never),
      ).toEqual({ valid: false, reason: 'evidence-invalid' });
    });
  });

  describe('LocalDestinationHealthProvider', () => {
    it('vouches for this server and leaves remote destinations unprobed', async () => {
      const provider = new LocalDestinationHealthProvider();
      await expect(provider.check(MediaOperationDestination.Local)).resolves.toMatchObject({
        destination: MediaOperationDestination.Local,
        state: 'available',
        checkedAt: expect.any(Date),
      });
      for (const destination of [MediaOperationDestination.Lan, MediaOperationDestination.FrameleafCloud]) {
        await expect(provider.check(destination)).resolves.toEqual({
          destination,
          state: 'unknown',
          reason: null,
          checkedAt: null,
        });
      }
    });
  });
});
