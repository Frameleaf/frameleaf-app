import { render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '../../../../../i18n/en.json';
import OnboardingServerPrivacy from './OnboardingServerPrivacy.svelte';

const saved = vi.hoisted(() => ({ versionCheck: false }));

vi.mock('$lib/managers/system-config-manager.svelte', () => ({
  systemConfigManager: {
    cloneValue: () => ({
      map: { enabled: true },
      newVersionCheck: { enabled: saved.versionCheck, channel: 'stable' },
    }),
  },
}));
vi.mock('$lib/services/system-config.service', () => ({ handleSystemConfigSave: vi.fn() }));

const versionSwitch = () => screen.getByRole('switch', { name: /Check for new versions/ });

describe('Onboarding server privacy (FL-80 O-8)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  it('turns the version check on by default on the first visit when nothing was chosen', () => {
    saved.versionCheck = false;
    render(OnboardingServerPrivacy, { firstVisit: true });
    expect(versionSwitch()).toBeChecked();
  });

  it('shows the saved choice when the admin comes back to the step', () => {
    saved.versionCheck = false;
    render(OnboardingServerPrivacy, { firstVisit: false });
    expect(versionSwitch()).not.toBeChecked();
  });

  it('keeps a saved on value', () => {
    saved.versionCheck = true;
    render(OnboardingServerPrivacy, { firstVisit: false });
    expect(versionSwitch()).toBeChecked();
  });
});
