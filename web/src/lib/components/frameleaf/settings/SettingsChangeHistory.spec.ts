import { SystemConfigHistoryCredentialChange, SystemConfigHistoryKind } from '@immich/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import SettingsChangeHistory from '$lib/components/frameleaf/settings/SettingsChangeHistory.svelte';
import en from '../../../../../../i18n/en.json';

/** FL-71 CC-10: titled entries and the account's own preference history (CommandCenter.jsx:2542-2583). */
beforeAll(() => addMessages('dev', en));

const base = { onRetry: vi.fn(), onConfigure: vi.fn(), configureLabel: 'Configure processing', ownName: 'Ada' };

describe('SettingsChangeHistory', () => {
  it('shows titled settings entries, falls back to the count, and interleaves own preference changes', async () => {
    render(SettingsChangeHistory, {
      ...base,
      entries: [
        {
          id: 'credential',
          createdAt: '2026-09-24T12:00:00.000Z',
          actorId: 'admin',
          actorName: 'Grace',
          kind: SystemConfigHistoryKind.Credential,
          title: 'Updated OAuth client secret',
          changes: [
            {
              path: 'oauth.clientSecret',
              before: null,
              after: null,
              credential: SystemConfigHistoryCredentialChange.Replaced,
            },
          ],
          omittedChanges: 0,
        },
        {
          id: 'old',
          createdAt: '2026-09-20T12:00:00.000Z',
          actorId: 'admin',
          actorName: 'Grace',
          changes: [{ path: 'trash.days', before: '30', after: '12' }],
          omittedChanges: 1,
        },
      ],
      preferences: [
        {
          id: 'pref',
          createdAt: '2026-09-22T12:00:00.000Z',
          deviceLabel: 'macOS · Web',
          changes: [
            { path: 'memories.enabled', before: 'true', after: 'false' },
            { path: 'privacy.suppression', before: null, after: null, protected: true },
          ],
          omittedChanges: 0,
        },
      ],
    });

    const titles = screen.getAllByRole('article').map((article) => article.querySelector('strong')?.textContent);
    expect(titles).toEqual(['Updated OAuth client secret', '2 preferences changed', '2 settings changed']);
    expect(screen.getByText('Ada · macOS · Web')).toBeInTheDocument();

    const preference = screen.getAllByRole('article')[1];
    await fireEvent.click(within(preference).getByText('View changes'));
    expect(within(preference).getByText('Changed · Locked content is not shown')).toBeInTheDocument();
    expect(within(preference).getByText(/Memories › Enabled/)).toBeInTheDocument();
  });

  it('offers the account its preferences when it has no history yet', async () => {
    const onConfigure = vi.fn();
    render(SettingsChangeHistory, {
      ...base,
      onConfigure,
      configureLabel: 'Open your preferences',
      entries: undefined,
      preferences: [],
    });

    expect(screen.getByText(en.frameleaf_settings_history_empty_preferences)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Open your preferences' }));
    expect(onConfigure).toHaveBeenCalled();
  });

  it('waits for both histories before drawing the timeline', () => {
    render(SettingsChangeHistory, { ...base, entries: [], preferences: null });

    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
