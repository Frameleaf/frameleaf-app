import type { StudioCommentDto, StudioProjectRevisionDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioProjectSession } from '$lib/frameleaf/studio/project-session';
import StudioHistoryPanel from './StudioHistoryPanel.svelte';

const toast = vi.hoisted(() => ({ toastUndo: vi.fn() }));
vi.mock('$lib/frameleaf/toast', () => toast);

const revisionAt = (revision: number, createdAt: string): StudioProjectRevisionDto => ({
  id: `r-${revision}`,
  revision,
  authorId: 'me',
  createdAt,
  digest: null,
  graphBytes: 10,
  restoredFromRevision: null,
  summary: { total: 3 } as StudioProjectRevisionDto['summary'],
});

const comment = (overrides: Partial<StudioCommentDto> = {}): StudioCommentDto => ({
  id: 'c-1',
  authorId: 'me',
  projectId: 'p-1',
  revision: 3,
  text: 'Trim the pause here',
  time: { num: 12_345, den: 1000 },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  resolvedAt: null,
  resolvedById: null,
  ...overrides,
});

const sessionWith = (overrides: Partial<StudioProjectSession> = {}) =>
  ({
    history: vi.fn().mockResolvedValue({
      items: [revisionAt(3, new Date().toISOString()), revisionAt(2, '2026-09-01T10:00:00.000Z')],
      total: 2,
    }),
    comments: vi.fn().mockResolvedValue({ items: [comment()], total: 1 }),
    restore: vi.fn().mockResolvedValue(true),
    addComment: vi.fn().mockImplementation(async (dto) => comment({ id: 'c-2', text: dto.text, time: dto.time })),
    updateComment: vi.fn(),
    ...overrides,
  }) as unknown as StudioProjectSession;

const props = (session: StudioProjectSession) => ({
  session,
  revision: 3,
  userId: 'me',
  access: 'owner' as const,
  canRestore: true,
  playhead: { num: 75, den: 1 },
  onClose: vi.fn(),
});

describe('Studio review drawer', () => {
  beforeEach(() => {
    toast.toastUndo.mockReset();
  });

  it('is named for the button that opens it and starts on the comments, at their timecode', async () => {
    render(StudioHistoryPanel, props(sessionWith()));

    const drawer = screen.getByRole('complementary', { name: 'frameleaf_studio_review' });
    expect(within(drawer).getByRole('radio', { name: 'frameleaf_studio_tab_comments' })).toBeChecked();
    expect(await within(drawer).findByText('Trim the pause here')).toBeInTheDocument();
    expect(within(drawer).getByText('00:12')).toBeInTheDocument();
    expect(within(drawer).queryByText('frameleaf_studio_history_version')).not.toBeInTheDocument();
  });

  it('pins a new comment to the playhead and says so on the field', async () => {
    const session = sessionWith();
    render(StudioHistoryPanel, props(session));
    await screen.findByText('Trim the pause here');

    // The dev locale prints the key; the timecode is the value handed to it.
    const field = screen.getByLabelText('frameleaf_studio_comment_at');
    await fireEvent.input(field, { target: { value: 'Louder music' } });
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_studio_comment_post_at' }));

    await waitFor(() =>
      expect(session.addComment).toHaveBeenCalledWith({ revision: 3, time: { num: 75, den: 1 }, text: 'Louder music' }),
    );
    expect(await screen.findByText('Louder music')).toBeInTheDocument();
    expect(screen.getByText('01:15')).toBeInTheDocument();
  });

  it('groups versions by day and goes back to one at once, with Undo to the version left', async () => {
    const session = sessionWith();
    render(StudioHistoryPanel, props(session));
    await fireEvent.click(screen.getByRole('radio', { name: 'frameleaf_studio_tab_versions' }));

    expect(await screen.findByRole('heading', { name: 'frameleaf_studio_history_today' })).toBeInTheDocument();
    expect(screen.getAllByRole('region')).toHaveLength(2);
    // The current version offers nothing; the older one offers the way back.
    const back = screen.getAllByRole('button', { name: 'frameleaf_studio_history_restore' });
    expect(back).toHaveLength(1);

    await fireEvent.click(back[0]);
    await waitFor(() => expect(session.restore).toHaveBeenCalledWith(2));
    await waitFor(() => expect(toast.toastUndo).toHaveBeenCalledTimes(1));

    const undo = toast.toastUndo.mock.calls[0][1] as () => void;
    undo();
    await waitFor(() => expect(session.restore).toHaveBeenLastCalledWith(3));
    // Undoing is not itself offered for undo.
    expect(toast.toastUndo).toHaveBeenCalledTimes(1);
  });

  it('says a failed read failed and asks again on Try again', async () => {
    const session = sessionWith({ history: vi.fn().mockRejectedValueOnce(new Error('offline')) });
    render(StudioHistoryPanel, props(session));

    const alert = await screen.findByRole('alert');
    (session.history as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [], total: 0 });
    await fireEvent.click(within(alert).getByRole('button'));
    expect(await screen.findByText('Trim the pause here')).toBeInTheDocument();
  });
});
