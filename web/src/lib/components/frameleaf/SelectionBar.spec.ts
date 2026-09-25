import { SharedLinkType } from '@immich/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { handleCreateSharedLink } from '$lib/services/shared-link.service';
import en from '../../../../../i18n/en.json';
import SelectionBar from './SelectionBar.svelte';

vi.mock('$lib/services/shared-link.service', () => ({
  asUrl: () => 'https://frameleaf.local/s/test',
  handleCreateSharedLink: vi.fn().mockResolvedValue(true),
  handleUpdateSharedLink: vi.fn(),
}));

it('shares every explicitly selected ID after part of the selection leaves the loaded window', async () => {
  addMessages('dev', en);
  render(SelectionBar, {
    props: {
      count: 2,
      assets: [{ id: 'loaded', ownerId: 'me' }],
      selectedIds: ['loaded', 'offscreen'],
      context: { currentUserId: 'me' },
      onAction: vi.fn(),
      onClear: vi.fn(),
    },
  });

  await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_bulk_create_shared_link }));
  await fireEvent.click(screen.getByRole('button', { name: en.create_link }));

  expect(handleCreateSharedLink).toHaveBeenCalledWith(
    expect.objectContaining({ type: SharedLinkType.Individual, assetIds: ['loaded', 'offscreen'] }),
  );
});

it('opens the preservation export on the selection and says what was left out (FL-74)', async () => {
  addMessages('dev', en);
  const onAction = vi.fn();
  render(SelectionBar, {
    props: {
      count: 3,
      assets: [
        { id: 'mine', ownerId: 'me' },
        { id: 'partner', ownerId: 'partner' },
      ],
      selectedIds: ['mine', 'partner', 'offscreen'],
      context: { currentUserId: 'me' },
      onAction,
      onClear: vi.fn(),
    },
  });

  await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_selection_more_actions }));
  await fireEvent.click(screen.getByRole('menuitem', { name: en.frameleaf_bulk_export_preservation }));

  const dialog = await screen.findByRole('dialog', { name: en.frameleaf_preservation_export_title });
  expect(within(dialog).getByRole('button', { name: en.frameleaf_preservation_scope_selection })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(within(dialog).getByText('2 selected items of yours')).toBeInTheDocument();
  expect(within(dialog).getByText('1 selected item belongs to someone else and is left out.')).toBeInTheDocument();
  expect(onAction).not.toHaveBeenCalled();
});

describe('one toolbar while selecting (September 24)', () => {
  const baseProps = () => ({
    count: 2,
    assets: [
      { id: 'a', ownerId: 'me' },
      { id: 'b', ownerId: 'me' },
    ],
    context: { currentUserId: 'me' },
    onAction: vi.fn(),
    onClear: vi.fn(),
  });

  it('puts the labelled page actions ahead of icon-only bulk actions named in tooltips', () => {
    addMessages('dev', en);
    const compare = vi.fn();
    const { container } = render(SelectionBar, {
      props: {
        ...baseProps(),
        leading: [
          { id: 'compare', label: 'Compare', icon: 'M0 0', onClick: compare },
          { id: 'studio', label: 'Open in Studio', icon: 'M0 0', onClick: vi.fn(), primary: true },
        ],
      },
    });

    const actions = [
      ...container.querySelectorAll<HTMLButtonElement>(':scope .actions > button, :scope .actions .more > button'),
    ];
    expect(actions.slice(0, 2).map((button) => button.textContent?.trim())).toEqual(['Compare', 'Open in Studio']);
    expect(container.querySelector(':scope .actions > .divider')).not.toBeNull();
    const favorite = screen.getByRole('button', { name: en.frameleaf_bulk_favorite });
    expect(favorite).toHaveClass('icon-only');
    expect(favorite).toHaveAttribute('title', en.frameleaf_bulk_favorite);
    expect(screen.getByRole('button', { name: 'Open in Studio' })).toHaveClass('is-primary');
  });

  it('runs a page action and keeps a disabled one inert', async () => {
    addMessages('dev', en);
    const compare = vi.fn();
    const edit = vi.fn();
    render(SelectionBar, {
      props: {
        ...baseProps(),
        leading: [
          { id: 'compare', label: 'Compare', icon: 'M0 0', onClick: compare },
          { id: 'quick-edit', label: 'Quick edit', icon: 'M0 0', onClick: edit, disabled: true },
        ],
      },
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Quick edit' }));

    expect(compare).toHaveBeenCalledOnce();
    expect(edit).not.toHaveBeenCalled();
  });

  it('keeps bulk action labels when the page has no actions of its own', () => {
    addMessages('dev', en);
    render(SelectionBar, { props: baseProps() });

    expect(screen.getByRole('button', { name: en.frameleaf_bulk_favorite })).not.toHaveClass('icon-only');
  });
});

describe('actions started from the library keys and tiles (FL-33, T-5)', () => {
  it('asks before a Locked item is deleted permanently, and reports a cancel', async () => {
    addMessages('dev', en);
    const onAction = vi.fn();
    const onDialogSettled = vi.fn();
    const { component } = render(SelectionBar, {
      props: {
        count: 1,
        assets: [{ id: 'a', ownerId: 'me', isLocked: true }],
        context: { currentUserId: 'me', locked: true },
        onAction,
        onClear: vi.fn(),
        onDialogSettled,
      },
    });

    component.performAction('delete-permanently');
    const dialog = await screen.findByRole('dialog', { name: en.frameleaf_bulk_delete_permanently });
    expect(onAction).not.toHaveBeenCalled();

    await fireEvent.click(within(dialog).getAllByRole('button', { name: en.cancel }).at(-1)!);
    await vi.waitFor(() => expect(onDialogSettled).toHaveBeenCalledWith('delete-permanently', false));
    expect(onAction).not.toHaveBeenCalled();

    component.performAction('delete-permanently');
    const again = await screen.findByRole('dialog', { name: en.frameleaf_bulk_delete_permanently });
    await fireEvent.click(within(again).getByRole('button', { name: en.frameleaf_bulk_delete_permanently }));
    expect(onAction).toHaveBeenCalledWith('delete-permanently', undefined);
    expect(onDialogSettled).toHaveBeenLastCalledWith('delete-permanently', true);
  });

  it('never runs an action the bar does not offer (favorite on the Locked page)', () => {
    const onAction = vi.fn();
    const { component } = render(SelectionBar, {
      props: {
        count: 1,
        assets: [{ id: 'a', ownerId: 'me', isLocked: true }],
        context: { currentUserId: 'me', locked: true },
        onAction,
        onClear: vi.fn(),
      },
    });
    component.performAction('favorite');
    expect(onAction).not.toHaveBeenCalled();
  });
});
