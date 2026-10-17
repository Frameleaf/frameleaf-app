import {
  SystemConfigHistoryCredentialChange,
  SystemConfigHistoryKind,
  SystemConfigHistorySource,
} from '@frameleaf/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import SettingsChangeHistory from '$lib/components/frameleaf/settings/SettingsChangeHistory.svelte';
import en from '../../../../../../i18n/en.json';

/** FL-368: every change in the words on its page (history.jsx), over FL-71 CC-10's record. */
beforeAll(() => addMessages('dev', en));

const now = new Date('2026-09-25T15:00:00.000Z');
const base = {
  onRetry: vi.fn(),
  ownName: 'Ada',
  now,
  pageTitle: ({ area, section }: { area: string; section?: string }) => [area, section].filter(Boolean).join(' › '),
};
const titles = () =>
  screen.getAllByRole('listitem').flatMap((item) => item.querySelector(':scope > .main > strong')?.textContent ?? []);

describe('SettingsChangeHistory', () => {
  it('writes a change in the words on its page, never the setting name or the stored value', () => {
    render(SettingsChangeHistory, {
      ...base,
      entries: undefined,
      preferences: [
        {
          id: 'ratings',
          createdAt: '2026-09-24T23:50:00.000Z',
          deviceLabel: null,
          changes: [{ path: 'ratings.enabled', before: 'false', after: 'true' }],
          omittedChanges: 0,
        },
        {
          id: 'two',
          createdAt: '2026-09-23T10:00:00.000Z',
          deviceLabel: 'macOS · Web',
          changes: [
            // D5: sizes are decimal (1 GB = 1,000,000,000 bytes).
            { path: 'download.archiveSize', before: String(4 * 1000 ** 3), after: String(10 * 1000 ** 3) },
            { path: 'cast.gCastEnabled', before: 'false', after: 'true' },
          ],
          omittedChanges: 0,
        },
      ],
    });

    expect(titles()).toEqual([
      'Star ratings turned on',
      'Split big downloads into files of: 4 GB → 10 GB · Cast to a TV turned on',
    ]);
    expect(screen.queryByText(/Ratings › Enabled|false|true/)).toBeNull();
    // The device is named when it is known and left out when it is not.
    expect(screen.getByText(/· Ada$/)).toBeInTheDocument();
    expect(screen.getByText(/· Ada · macOS · Web$/)).toBeInTheDocument();
    expect(screen.queryByText(/without a session/)).toBeNull();
    // Each entry says the page it lives on and has a way to open it.
    const first = screen.getAllByRole('listitem')[0];
    expect(within(first).getByText('preferences › feature')).toBeInTheDocument();
    expect(within(first).getByRole('link', { name: 'Open this setting' })).toHaveAttribute(
      'href',
      '/user-settings?area=preferences&section=feature',
    );
    expect(within(first).getByText('Just you')).toBeInTheDocument();
  });

  it('groups by day, keeps a recorded title, counts more than two changes and never shows a credential', async () => {
    render(SettingsChangeHistory, {
      ...base,
      entries: [
        {
          id: 'credential',
          createdAt: '2026-09-25T12:00:00.000Z',
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
          createdAt: '2026-09-10T12:00:00.000Z',
          actorId: 'admin',
          actorName: 'Grace',
          changes: [
            { path: 'newVersionCheck.enabled', before: 'false', after: 'true' },
            { path: 'logging.level', before: '"log"', after: '"debug"' },
          ],
          omittedChanges: 1,
        },
      ],
      preferences: [
        {
          id: 'pref',
          createdAt: '2026-09-24T12:00:00.000Z',
          deviceLabel: 'macOS · Web',
          changes: [{ path: 'privacy.suppression', before: null, after: null, protected: true }],
          omittedChanges: 0,
        },
      ],
    });

    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      'Today',
      'Yesterday',
      'Earlier',
    ]);
    expect(titles()).toEqual([
      'Updated OAuth client secret',
      expect.stringContaining('Changed · Locked content is not shown'),
      '3 settings changed',
    ]);
    const [credential, , old] = screen.getAllByRole('listitem').filter((item) => item.querySelector('.main'));
    expect(within(credential).getByText('Saved (never shown)')).toBeInTheDocument();
    expect(within(credential).getByText('Whole server')).toBeInTheDocument();

    await fireEvent.click(within(old).getByText('Show the 3 changes'));
    expect(within(old).getByText('Look for updates')).toBeInTheDocument();
    expect(within(old).getByText('How much to record')).toBeInTheDocument();
    expect(within(old).getByText('Detail for finding a fault')).toBeInTheDocument();
    expect(within(old).getByText('1 more change is not shown')).toBeInTheDocument();
  });

  it('labels changes from the server command line and Frameleaf Cloud (FL-146)', () => {
    const entry = (id: string, source: SystemConfigHistorySource, actorName: string | null) => ({
      id,
      createdAt: `2026-09-2${id.length % 5}T12:00:00.000Z`,
      actorId: actorName ? 'admin' : null,
      actorName,
      kind: SystemConfigHistoryKind.Settings,
      source,
      changes: [{ path: 'passwordLogin.enabled', before: 'true', after: 'false' }],
      omittedChanges: 0,
    });

    render(SettingsChangeHistory, {
      ...base,
      entries: [
        entry('cli', SystemConfigHistorySource.ServerCli, null),
        entry('cloud-admin', SystemConfigHistorySource.FrameleafCloud, 'Grace'),
        entry('cloud', SystemConfigHistorySource.FrameleafCloud, null),
      ],
      preferences: [],
    });

    expect(screen.getByText(/· Server command line$/)).toBeInTheDocument();
    expect(screen.getByText(/· Grace · Frameleaf Cloud$/)).toBeInTheDocument();
    expect(screen.getAllByText(/· Frameleaf Cloud$/)).toHaveLength(2);
    expect(screen.queryByText('An administrator')).not.toBeInTheDocument();
  });

  it('says there is no history yet and offers nothing else to do (ADMIN-P8)', () => {
    render(SettingsChangeHistory, { ...base, entries: undefined, preferences: [] });

    expect(screen.getByRole('heading', { name: 'No changes yet' })).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_words_history_empty_own)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('gives an administrator no shortcut away from an empty history either', () => {
    render(SettingsChangeHistory, { ...base, entries: [], preferences: [] });

    expect(screen.getByText(en.frameleaf_words_history_empty_body)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Configure processing' })).not.toBeInTheDocument();
  });

  it('waits for both histories before drawing the timeline', () => {
    render(SettingsChangeHistory, { ...base, entries: [], preferences: null });
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
