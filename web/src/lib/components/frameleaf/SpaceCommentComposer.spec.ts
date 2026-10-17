import { AlbumUserRole, type SharedSpaceMemberResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import SpaceCommentComposer from './SpaceCommentComposer.svelte';

const member = (id: string, name: string): SharedSpaceMemberResponseDto =>
  ({
    user: { id, name, email: `${id}@example.com`, profileImagePath: '', avatarColor: 'primary', profileChangedAt: '' },
    role: AlbumUserRole.Editor,
    pending: false,
  }) as unknown as SharedSpaceMemberResponseDto;

const members = [member('ada', 'Ada'), member('bo', 'Bo'), member('cy', 'Cy')];

/** Types into the box the way a keyboard does: input, then the key's release. */
const type = async (box: HTMLTextAreaElement, text: string) => {
  await fireEvent.input(box, { target: { value: text } });
  box.setSelectionRange(text.length, text.length);
  await fireEvent.keyUp(box, { key: text.at(-1) });
};

/** A key press: its keydown and its keyup, as a browser sends them. */
const press = async (box: HTMLTextAreaElement, key: string, init: KeyboardEventInit = {}) => {
  await fireEvent.keyDown(box, { key, ...init });
  await fireEvent.keyUp(box, { key, ...init });
};

describe('SpaceCommentComposer', () => {
  it('picks the mention the arrow keys moved to', async () => {
    const onSubmit = vi.fn();
    render(SpaceCommentComposer, { members, currentUserId: 'ada', placeholder: 'Comment', onSubmit });
    const box = screen.getByRole('textbox', { name: 'Comment' }) as HTMLTextAreaElement;

    await type(box, 'hi @');
    expect(screen.getAllByRole('option')).toHaveLength(2);
    await press(box, 'ArrowDown');
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    await press(box, 'Enter');

    expect(box).toHaveValue('hi @{cy} ');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not post while a composition (an input method) is still open', async () => {
    const onSubmit = vi.fn();
    render(SpaceCommentComposer, { members, currentUserId: 'ada', placeholder: 'Comment', onSubmit });
    const box = screen.getByRole('textbox', { name: 'Comment' }) as HTMLTextAreaElement;

    await type(box, 'こんにちは');
    await fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();

    await press(box, 'Enter');
    expect(onSubmit).toHaveBeenCalledWith('こんにちは');
  });
});
