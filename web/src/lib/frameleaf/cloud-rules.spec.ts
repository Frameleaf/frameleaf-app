import { CloudLinkState, LicenseState, type LicenseStatusResponseDto } from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import { FEATURES, gateButtonKey, haveFrom, missing, type CloudHave } from '$lib/frameleaf/cloud-rules';

const have = (patch: Partial<CloudHave> = {}): CloudHave => ({
  linked: true,
  licence: 'server',
  plan: true,
  credit: true,
  configured: true,
  store: true,
  ...patch,
});

describe('Frameleaf Cloud rules (FL-544: one table for every gate)', () => {
  it('needs nothing extra once Frameleaf Cloud is on the server', () => {
    for (const feature of ['remote', 'backup', 'signin', 'buddy', 'processing'] as const) {
      expect(missing(feature, have())).toEqual([]);
    }
  });

  it('starts every feature with the link when the server is not linked', () => {
    const unlinked = have({ linked: false, licence: 'none', plan: false, credit: false });
    expect(missing('remote', unlinked)).toEqual(['link', 'cloud']);
    expect(missing('backup', unlinked)).toEqual(['link', 'cloud']);
    expect(missing('processing', unlinked)).toEqual(['link', 'licence', 'credit']);
    expect(missing('buddy', unlinked)).toEqual(['link', 'licence']);
  });

  it('asks a linked server with nothing bought for Frameleaf Cloud, or the licence and credit', () => {
    const linked = have({ licence: 'none', plan: false, credit: false });
    expect(missing('remote', linked)).toEqual(['cloud']);
    expect(missing('signin', linked)).toEqual(['cloud']);
    expect(missing('processing', linked)).toEqual(['licence', 'credit']);
  });

  it('treats a licence-only server as ready for processing once it has credit, and not for the plan features', () => {
    expect(missing('processing', have({ plan: false }))).toEqual([]);
    expect(missing('processing', have({ plan: false, credit: false }))).toEqual(['credit']);
    expect(missing('remote', have({ plan: false }))).toEqual(['cloud']);
  });

  it('requires a Server licence for Buddy Backup even when an Individual one is held', () => {
    expect(missing('buddy', have({ licence: 'individual' }))).toEqual(['licence']);
    expect(missing('processing', have({ licence: 'individual' }))).toEqual([]);
  });

  it('names the button after the first thing missing: Frameleaf Cloud unless only credit is short', () => {
    expect(gateButtonKey(['credit'])).toBe('frameleaf_add_ai_credit');
    expect(gateButtonKey(['licence', 'credit'])).toBe('frameleaf_get_cloud');
    expect(gateButtonKey(['link', 'cloud'])).toBe('frameleaf_get_cloud');
    expect(gateButtonKey([])).toBe('frameleaf_get_cloud');
  });

  it('keeps one gate sentence per feature, none naming a plan or licence to the user', () => {
    for (const feature of Object.values(FEATURES)) {
      expect(feature.gateKey).toMatch(/^frameleaf_gate_/);
      expect(feature.onKey).toMatch(/^frameleaf_on_/);
    }
    expect(FEATURES.remote.needs).toBe('cloud');
    expect(FEATURES.buddy.needs).toBe('licence');
    expect(FEATURES.processing.needs).toBe('credit');
  });

  describe('haveFrom', () => {
    const license = (patch: Partial<LicenseStatusResponseDto> = {}): LicenseStatusResponseDto =>
      ({
        state: LicenseState.None,
        kind: null,
        keyHint: null,
        expiresAt: null,
        graceUntil: null,
        fingerprint: { instanceId: null, jkt: null },
        entitlements: {
          frameleafCloud: false,
          remoteAccess: false,
          cloudMl: false,
          cloudBackup: false,
          supporter: false,
        },
        licensed: false,
        refresh: { refreshedAt: null, nextRefreshAt: null, lastError: null },
        offline: false,
        linked: true,
        configured: true,
        key: null,
        plan: null,
        ...patch,
      }) as LicenseStatusResponseDto;
    const slot = (kind: 'server' | 'individual' | 'plan', state: LicenseState = LicenseState.Active) =>
      ({
        state,
        kind,
        source: 'account',
        keyHint: null,
        activatedAt: '2026-10-24T00:00:00.000Z',
        expiresAt: null,
        graceUntil: null,
        refreshedAt: null,
      }) as LicenseStatusResponseDto['key'];

    it('reads the link, the licence kind, the plan and the credit from the manager state', () => {
      expect(
        haveFrom(
          { state: CloudLinkState.Linked, configured: true },
          license({ key: slot('server'), plan: slot('plan'), state: LicenseState.Active }),
          { storeUrl: 'https://frameleaf.cloud/store' },
          { availableUsd: 4 },
        ),
      ).toEqual({ linked: true, licence: 'server', plan: true, credit: true, configured: true, store: true });
    });

    it('counts a plan in grace as held and an expired one as missing', () => {
      expect(
        haveFrom(
          { state: CloudLinkState.Linked, configured: true },
          license({ plan: slot('plan', LicenseState.Grace) }),
          null,
          null,
        ).plan,
      ).toBe(true);
      expect(
        haveFrom(
          { state: CloudLinkState.Linked, configured: true },
          license({ plan: slot('plan', LicenseState.Expired) }),
          null,
          null,
        ).plan,
      ).toBe(false);
    });

    it('reports an unconfigured server and a missing store so a gate can say purchasing is unavailable', () => {
      expect(haveFrom({ state: CloudLinkState.NotConfigured, configured: false }, null, null, null)).toEqual({
        linked: false,
        licence: 'none',
        plan: false,
        credit: false,
        configured: false,
        store: false,
      });
      expect(
        haveFrom(
          { state: CloudLinkState.Unlinked, configured: true },
          license({ linked: false }),
          { storeUrl: null },
          null,
        ).store,
      ).toBe(false);
    });
  });
});
