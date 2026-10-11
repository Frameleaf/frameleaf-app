import { render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import en from '../../../../../../i18n/en.json';
import ConfigurationTransferSection from './ConfigurationTransferSection.svelte';

const baseline = { map: { enabled: true }, oauth: { clientSecret: 'secret-value' } };

const changes = vi.hoisted(() => [] as { path: string; before: unknown; after: unknown }[]);

vi.mock('$lib/frameleaf/system-config-draft.svelte', () => ({
  getSystemConfigDraft: () => ({ baseline, changes, importFile: vi.fn() }),
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

    const included = screen.getByRole('list', { name: 'What is included' });
    expect(included).toHaveTextContent('Never passwords, keys or sign-ins inside an address');
    // The file itself is behind "Show the file", closed until asked for.
    const preview = document.querySelector('pre')!;
    expect(preview.closest('details')).not.toHaveAttribute('open');
    expect(preview.textContent).toContain('"enabled": true');
    expect(preview.textContent).not.toContain('secret-value');
    expect(screen.getByRole('button', { name: 'Save to a file' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load from a file' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy as text' })).toBeInTheDocument();
  });

  it('lists a loaded file as changes in the words on their pages, saved only from the settings bar', () => {
    changes.push({ path: 'map.enabled', before: true, after: false });
    render(ConfigurationTransferSection);

    expect(screen.getByText('1 setting is waiting to be saved')).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Settings that would change' });
    expect(list).toHaveTextContent('Show photos on a map');
    expect(list).toHaveTextContent('On');
    expect(list).toHaveTextContent('Off');
    expect(list).not.toHaveTextContent('map.enabled');
    changes.length = 0;
  });
});
