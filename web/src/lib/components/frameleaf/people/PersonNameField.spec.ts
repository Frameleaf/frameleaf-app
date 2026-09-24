import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { personFactory } from '@test-data/factories/person-factory';
import PersonNameField from './PersonNameField.svelte';

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  searchPerson: vi.fn().mockResolvedValue([]),
}));

// Without loaded messages `$t` returns the key, so the assertions read the keys the field uses.
const SAVE = 'frameleaf_people_save_name';
const CANCEL = 'frameleaf_people_cancel_rename';

describe('PersonNameField', () => {
  const person = personFactory.build({ id: 'p1', name: 'Ada' });

  it('offers icon-only save and cancel controls named for assistive tech (PN-2)', () => {
    render(PersonNameField, { person, onCommit: vi.fn(), onCancel: vi.fn() });

    const save = screen.getByRole('button', { name: SAVE });
    const cancel = screen.getByRole('button', { name: CANCEL });
    expect(save.querySelector('svg')).not.toBeNull();
    expect(cancel.querySelector('svg')).not.toBeNull();
    expect(save.textContent?.trim()).toBe('');
    expect(cancel.textContent?.trim()).toBe('');
  });

  it('commits the trimmed name on submit', async () => {
    const onCommit = vi.fn();
    const { container } = render(PersonNameField, { person, onCommit, onCancel: vi.fn() });

    const input = container.querySelector<HTMLInputElement>('input')!;
    await fireEvent.input(input, { target: { value: '  Ada Lovelace  ' } });
    await fireEvent.submit(container.querySelector('form')!);

    expect(onCommit).toHaveBeenCalledExactlyOnceWith('Ada Lovelace');
  });

  it('cancels instead of saving when focus leaves the editor (PN-1)', async () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const { container } = render(PersonNameField, { person, onCommit, onCancel });

    const input = container.querySelector<HTMLInputElement>('input')!;
    await fireEvent.input(input, { target: { value: 'Ada Lovelace' } });
    await fireEvent.focusOut(input, { relatedTarget: document.body });

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('keeps editing when focus moves to a control inside the editor', async () => {
    const onCancel = vi.fn();
    const { container } = render(PersonNameField, { person, onCommit: vi.fn(), onCancel });

    const input = container.querySelector<HTMLInputElement>('input')!;
    await fireEvent.focusOut(input, { relatedTarget: screen.getByRole('button', { name: SAVE }) });

    expect(onCancel).not.toHaveBeenCalled();
  });

  it('cancels from the cancel control', async () => {
    const onCancel = vi.fn();
    render(PersonNameField, { person, onCommit: vi.fn(), onCancel });

    await fireEvent.click(screen.getByRole('button', { name: CANCEL }));

    expect(onCancel).toHaveBeenCalledOnce();
  });
});
