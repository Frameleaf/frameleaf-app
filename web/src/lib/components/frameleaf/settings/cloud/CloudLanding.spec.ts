import { LicenseKind, LicenseState } from '@frameleaf/sdk';
import { render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '../../../../../../../i18n/en.json';
import CloudLanding from './CloudLanding.svelte';
import { cloudNeeds } from './cloud-landing';

const cloud = vi.hoisted(() => ({ status: null as unknown, license: null as unknown }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/managers/cloud-manager.svelte', () => ({
  cloudManager: {
    listen: () => () => {},
    get status() {
      return cloud.status;
    },
    get license() {
      return cloud.license;
    },
  },
}));

describe('Frameleaf Cloud landing (FL-367)', () => {
  beforeAll(() => addMessages('dev', en));

  it('says when Frameleaf Cloud is turned off and sends nothing', () => {
    cloud.status = { state: 'not_configured', configured: false, remoteAccessEnabled: false };
    render(CloudLanding);
    expect(screen.getByRole('heading', { name: 'Frameleaf Cloud is turned off for this server' })).toBeInTheDocument();
    expect(screen.queryByText('What you have')).not.toBeInTheDocument();
    expect(screen.getByText('What you need for each feature')).toBeInTheDocument();
  });

  it('lists what a linked server has, with a plan and a licence', () => {
    cloud.status = {
      state: 'linked',
      configured: true,
      remoteAccessEnabled: true,
      account: { id: 'x', label: 'taylor@example.test' },
      linkedAt: '2026-03-03T00:00:00.000Z',
    };
    cloud.license = {
      state: LicenseState.Active,
      plan: { kind: LicenseKind.Plan, state: LicenseState.Active, expiresAt: '2027-03-03T00:00:00.000Z' },
      key: { kind: LicenseKind.Server, state: LicenseState.Active },
      entitlements: {},
    };
    render(CloudLanding);
    expect(screen.getByRole('heading', { name: 'Linked to Frameleaf, and everything is working' })).toBeInTheDocument();
    expect(screen.getByText('Server licence')).toBeInTheDocument();
    expect(screen.getByText('Plan active')).toBeInTheDocument();
    expect(screen.getByText('$9.99 a month or $99.90 a year')).toBeInTheDocument();
  });
});

describe('what each feature needs', () => {
  it('works out each row from what the server has', () => {
    const needs = cloudNeeds({ off: false, linked: true, hasPlan: false, licence: LicenseKind.Server });
    expect(Object.fromEntries(needs.map((need) => [need.id, need.state]))).toEqual({
      apps: 'have',
      remote: 'not',
      cloud_backup: 'not',
      buddy_backup: 'have',
      processing: 'have',
      everything: 'always',
    });
    expect(
      cloudNeeds({ off: true, linked: true, hasPlan: true, licence: null }).every(
        (need) => need.state === 'not' || need.id === 'everything',
      ),
    ).toBe(true);
  });
});
