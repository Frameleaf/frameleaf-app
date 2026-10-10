import { render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import en from '../../../../../../i18n/en.json';
import ConfigurationTransferSection from './ConfigurationTransferSection.svelte';

const baseline = { map: { enabled: true }, oauth: { clientSecret: 'secret-value' } };

vi.mock('$lib/frameleaf/system-config-draft.svelte', () => ({
  getSystemConfigDraft: () => ({ baseline, importFile: vi.fn() }),
}));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { configFile: false } },
}));

describe('ConfigurationTransferSection (CC-46)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  it('discloses what an export includes, never a credential value', () => {
    render(ConfigurationTransferSection);

    expect(screen.getByText('What is included')).toBeInTheDocument();
    const preview = document.querySelector('pre')!;
    expect(preview.textContent).toContain('"enabled": true');
    expect(preview.textContent).not.toContain('secret-value');
    expect(screen.getByRole('button', { name: 'Import settings' })).toBeInTheDocument();
  });
});
