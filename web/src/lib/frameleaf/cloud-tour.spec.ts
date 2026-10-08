import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  activeEntitlements,
  CLOUD_TOUR_ENDINGS,
  clampTourStep,
  cloudTourStatus,
  cloudTourSteps,
  linkKey,
  lowestMonthlyPlanUsd,
  pointKey,
  requestedTourStep,
  stepKey,
  type CloudTourFacts,
} from '$lib/frameleaf/cloud-tour';
import { SETTINGS_AREAS } from '$lib/frameleaf/settings-areas';

const messages = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../i18n/en.json'), 'utf8')) as Record<
  string,
  string
>;

const NOW = Date.UTC(2026, 8, 27);

const facts = (patch: Partial<CloudTourFacts> = {}): CloudTourFacts => ({
  license: {
    entitlements: { cloudBackup: false, cloudMl: false, frameleafCloud: false, remoteAccess: false, supporter: false },
    plan: null,
  },
  remoteAccessEnabled: false,
  customHostnameVerified: false,
  processingEnabled: false,
  walletAvailableUsd: null,
  backupConfigured: false,
  ...patch,
});

const planned = (patch: Partial<CloudTourFacts> = {}, state: 'active' | 'grace' | 'expired' = 'active') =>
  facts({
    license: {
      entitlements: { cloudBackup: true, cloudMl: true, frameleafCloud: true, remoteAccess: true, supporter: false },
      plan: { state: state as never, graceUntil: state === 'grace' ? '2026-10-10T00:00:00.000Z' : null },
    },
    ...patch,
  });

describe('linked-server tour (FL-196)', () => {
  it('colours each tile by role, keeps indigo for the AI step, and opens Cloud backup under Backup', () => {
    for (const step of cloudTourSteps) {
      expect(['blue', 'teal', 'accent', 'ai', 'neutral'], step.id).toContain(step.tile);
      expect(step.tile === 'ai', step.id).toBe(!!step.ai);
    }
    const backup = cloudTourSteps.find(({ id }) => id === 'backup')!.links[0];
    expect(backup).toMatchObject({ area: 'backups', params: { backupView: 'cloud' } });
    expect(backup.section).toBeUndefined();
  });

  it('has the six prototype steps, and every step opens a real settings page', () => {
    expect(cloudTourSteps.map(({ id }) => id)).toEqual(['remote', 'address', 'signin', 'processing', 'backup', 'plan']);
    for (const step of cloudTourSteps) {
      expect(step.points.length).toBe(3);
      expect(step.links.length).toBeGreaterThanOrEqual(1);
      for (const link of step.links) {
        const area = SETTINGS_AREAS.find(({ id }) => id === link.area);
        expect(area, `${step.id}: ${link.area}`).toBeDefined();
        if (link.section) {
          expect([...area!.sections, ...(area!.personal ?? [])]).toContain(link.section);
        }
      }
    }
    expect(cloudTourSteps.find(({ id }) => id === 'processing')?.ai).toBe(true);
  });

  it('has copy for every step, point and link, in US dollars and without internal terms', () => {
    const keys = cloudTourSteps.flatMap((step) => [
      stepKey(step.id, 'title'),
      stepKey(step.id, 'summary'),
      ...step.points.flatMap((point) => [pointKey(step.id, point.id, 'title'), pointKey(step.id, point.id, 'text')]),
      ...step.links.map((link) => linkKey(link.id)),
    ]);
    for (const key of keys) {
      expect(messages[key], key).toEqual(expect.any(String));
    }
    const copy = keys.map((key) => messages[key]).join('\n');
    expect(copy).toMatch(/US dollars/);
    expect(copy).toMatch(/from \{price\} a month/);
    expect(copy).not.toMatch(/\bfork\b|Immich|RunPod|€|£/i);
    expect(messages[stepKey('remote', 'title')]).toBe('Reach your photos from anywhere');
    expect(messages[linkKey('cloud')]).toBe('Open Frameleaf Cloud');
  });

  it('shows what needs a plan instead of promising it', () => {
    const state = facts();
    expect(cloudTourStatus('remote', state, NOW)).toMatchObject({ key: 'frameleaf_cloud_tour_status_needs_plan' });
    expect(cloudTourStatus('address', state, NOW)).toMatchObject({ key: 'frameleaf_cloud_tour_status_needs_plan' });
    expect(cloudTourStatus('backup', state, NOW)).toMatchObject({ key: 'frameleaf_cloud_tour_status_needs_plan' });
    expect(cloudTourStatus('signin', state, NOW)).toMatchObject({ key: 'frameleaf_cloud_tour_status_available' });
    expect(cloudTourStatus('plan', state, NOW)).toEqual({
      kind: 'plan',
      state: 'none',
      graceUntil: null,
      licensed: false,
      tone: 'muted',
    });
  });

  it('reads remote access, the address and backup from this server once a plan includes them', () => {
    expect(cloudTourStatus('remote', planned(), NOW)).toMatchObject({
      key: 'frameleaf_cloud_tour_status_ready_to_turn_on',
    });
    expect(cloudTourStatus('remote', planned({ remoteAccessEnabled: true }), NOW)).toMatchObject({
      key: 'frameleaf_cloud_tour_status_on',
      tone: 'ok',
    });
    expect(cloudTourStatus('address', planned({ remoteAccessEnabled: true }), NOW)).toMatchObject({
      key: 'frameleaf_cloud_tour_status_frameleaf_address_ready',
    });
    expect(cloudTourStatus('address', planned({ customHostnameVerified: true }), NOW)).toMatchObject({
      key: 'frameleaf_cloud_tour_status_own_domain_verified',
    });
    expect(cloudTourStatus('backup', planned(), NOW)).toMatchObject({
      key: 'frameleaf_cloud_tour_status_ready_to_set_up',
    });
    expect(cloudTourStatus('backup', planned({ backupConfigured: true }), NOW)).toMatchObject({
      key: 'frameleaf_cloud_tour_status_on',
    });
  });

  it('keeps cloud features through the grace period and drops them once it lapses', () => {
    expect(activeEntitlements(planned({}, 'grace').license, NOW)).toEqual({ remoteAccess: true, cloudBackup: true });
    expect(activeEntitlements(planned({}, 'grace').license, Date.UTC(2026, 10, 1))).toEqual({
      remoteAccess: false,
      cloudBackup: false,
    });
    expect(cloudTourStatus('plan', planned({}, 'grace'), NOW)).toMatchObject({ state: 'grace', tone: 'warning' });
    expect(cloudTourStatus('plan', planned({}, 'expired'), NOW)).toMatchObject({ state: 'expired', tone: 'warning' });
    expect(cloudTourStatus('plan', planned(), NOW)).toMatchObject({ state: 'active', tone: 'ok' });
  });

  it('marks a licensed server on the plan chip', () => {
    const licensed = facts({
      license: {
        entitlements: {
          cloudBackup: false,
          cloudMl: false,
          frameleafCloud: false,
          remoteAccess: false,
          supporter: true,
        },
        plan: null,
      },
    });
    expect(cloudTourStatus('plan', licensed, NOW)).toMatchObject({ state: 'none', licensed: true });
    expect(messages.frameleaf_cloud_tour_status_licensed).toBe('{plan} · Licensed');
  });

  it('shows the AI credit in US dollars when the wallet was read, and just on or off when not', () => {
    expect(cloudTourStatus('processing', facts(), NOW)).toMatchObject({ key: 'frameleaf_cloud_tour_status_off' });
    expect(cloudTourStatus('processing', facts({ processingEnabled: true }), NOW)).toMatchObject({
      key: 'frameleaf_cloud_tour_status_on',
      tone: 'ok',
    });
    expect(cloudTourStatus('processing', facts({ walletAvailableUsd: 12.5 }), NOW)).toEqual({
      kind: 'credit',
      on: false,
      usd: 12.5,
      tone: 'muted',
    });
    expect(messages.frameleaf_cloud_tour_status_credit_on).toBe('On · {amount} AI credit');
  });

  it('prices plans from the lowest monthly plan', () => {
    expect(
      lowestMonthlyPlanUsd([
        { kind: 'plan', period: 'year', priceUsd: 60 },
        { kind: 'plan', period: 'month', priceUsd: 6 },
        { kind: 'supporter', period: 'lifetime', priceUsd: 5 },
      ]),
    ).toBe(6);
    expect(lowestMonthlyPlanUsd([])).toBeNull();
  });

  it('clamps step requests and reads review links', () => {
    expect(clampTourStep('2')).toBe(2);
    expect(clampTourStep(-4)).toBe(0);
    expect(clampTourStep(99)).toBe(cloudTourSteps.length - 1);
    expect(clampTourStep('nope')).toBe(0);
    expect(clampTourStep(null)).toBe(0);
    expect(requestedTourStep(new URLSearchParams('tour=cloud&tourStep=3'))).toBe(3);
    expect(requestedTourStep(new URLSearchParams('tour=cloud'))).toBe(0);
    expect(requestedTourStep(new URLSearchParams('tour=other'))).toBeNull();
    expect(requestedTourStep(new URLSearchParams(''))).toBeNull();
  });

  it('knows the four endings the server records', () => {
    expect(CLOUD_TOUR_ENDINGS).toEqual(['finished', 'skipped', 'opened-settings', 'setup']);
  });
});
